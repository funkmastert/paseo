import { mkdtempSync, rmSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkItem } from "@getpaseo/protocol/coordination/queue-schemas";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { deriveSuccessorId } from "../coordination/queue/store.js";

// The work queue's chaos cases (docs/work-queue.md#storage), against isolated in-process daemons
// that share one PASEO_HOME. The "kill" is the store's onCommitStep seam throwing between the
// successor write and the source close, then the daemon stops without finishing the commit; the
// next daemon opens the same directory. That is the state a SIGKILL there leaves on disk, which
// the test checks before restarting.

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
}, 60_000);

async function startDaemon(
  homeRoot: string,
  overrides: Parameters<typeof createTestPaseoDaemon>[0] = {},
): Promise<{ daemon: TestPaseoDaemon; client: DaemonClient }> {
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: homeRoot,
    cleanup: false,
    coordination: { enabled: true },
    ...overrides,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await daemon.close();
  });
  return { daemon, client };
}

async function stop(running: { daemon: TestPaseoDaemon; client: DaemonClient }): Promise<void> {
  await running.client.close().catch(() => undefined);
  await running.daemon.close();
}

async function readItemFile(paseoHome: string, id: string): Promise<WorkItem> {
  const file = path.join(paseoHome, "coordination", "queue", "items", `${id}.json`);
  return JSON.parse(await readFile(file, "utf8")) as WorkItem;
}

async function makeHomeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "work-queue-chaos-"));
  cleanups.unshift(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("work queue chaos", () => {
  test("kill-daemon-mid-handoff: the next daemon finishes the handoff with one open successor", async () => {
    const homeRoot = await makeHomeRoot();
    const sourceId = "wi-handoff-source";
    const successorId = deriveSuccessorId(sourceId);
    let killed = false;

    const first = await startDaemon(homeRoot, {
      coordinationOverrides: {
        onCommitStep: async (step) => {
          if (
            step.kind === "item-written" &&
            step.op === "handoff" &&
            step.itemId === successorId
          ) {
            killed = true;
            throw new Error("simulated daemon death between successor write and source close");
          }
        },
      },
    });
    expect(first.client.getLastServerInfoMessage()?.features?.coordinationQueue).toBe(true);
    const created = await first.client.coordinationQueueCreate({
      id: sourceId,
      title: "Review the plan",
      owner: "human",
    });
    expect(created.error).toBeUndefined();

    const handoff = await first.client.coordinationQueueHandoff({ id: sourceId, to: "human" });
    expect(killed).toBe(true);
    expect(handoff.errorCode).toBe("internal");
    await stop(first);

    // What the dead daemon left: the successor written, the source still open, no commit line.
    const paseoHome = path.join(homeRoot, ".paseo");
    expect(await readItemFile(paseoHome, successorId)).toMatchObject({ state: "pending" });
    expect(await readItemFile(paseoHome, sourceId)).toMatchObject({ state: "pending" });

    const second = await startDaemon(homeRoot);
    const all = await second.client.coordinationQueueList({ filter: { limit: 100 } });
    const open = (all.items ?? []).filter((item) => item.state === "pending");
    expect(open.map((item) => item.id)).toEqual([successorId]);
    expect(open[0]).toMatchObject({ handedOffFrom: sourceId, owner: "human" });

    const source = await second.client.coordinationQueueShow({ id: sourceId });
    expect(source.item).toMatchObject({ state: "handed-off", handedOffTo: successorId });

    // A retry of the same handoff returns the pair; it never mints a second successor.
    const retry = await second.client.coordinationQueueHandoff({ id: sourceId, to: "human" });
    expect(retry).toMatchObject({ changed: false, successor: { id: successorId } });
  }, 60_000);

  test("queue-baton-survives-restart: an item created for an agent is intact and claimable", async () => {
    const homeRoot = await makeHomeRoot();
    const cwd = mkdtempSync(path.join(tmpdir(), "work-queue-chaos-cwd-"));
    cleanups.unshift(async () => rmSync(cwd, { recursive: true, force: true }));

    const first = await startDaemon(homeRoot);
    const agent = await first.client.createAgent({ provider: "claude", cwd, title: "Queue owner" });
    const created = await first.client.coordinationQueueCreate({
      id: "wi-baton",
      title: "Carry the baton",
      body: "Survives a restart.",
      owner: agent.id,
      actor: "human",
    });
    expect(created).toMatchObject({ changed: true, item: { owner: agent.id, state: "pending" } });

    // Delivery is recorded asynchronously; wait for it before the restart.
    let delivered: WorkItem | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const shown = await first.client.coordinationQueueShow({ id: "wi-baton" });
      if (shown.item?.delivery?.state !== "not_attempted") {
        delivered = shown.item;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(delivered?.delivery).toMatchObject({ state: "delivered" });
    await stop(first);

    const second = await startDaemon(homeRoot);
    const shown = await second.client.coordinationQueueShow({ id: "wi-baton" });
    expect(shown.item).toMatchObject({
      id: "wi-baton",
      title: "Carry the baton",
      body: "Survives a restart.",
      owner: agent.id,
      state: "pending",
      delivery: { state: "delivered" },
    });
    expect(shown.transitions?.map((row) => row.to)).toEqual(["pending"]);

    const claimed = await second.client.coordinationQueueClaim({ id: "wi-baton", actor: agent.id });
    expect(claimed).toMatchObject({
      changed: true,
      item: { state: "in-progress", owner: agent.id },
    });
  }, 60_000);

  test("coordination off: no feature flag, and requests are answered as disabled", async () => {
    const homeRoot = await makeHomeRoot();
    const off = await startDaemon(homeRoot, { coordination: { enabled: false } });
    expect(off.client.getLastServerInfoMessage()?.features?.coordinationQueue).toBeUndefined();
    const response = await off.client.coordinationQueueList({});
    expect(response.errorCode).toBe("disabled");
  }, 60_000);
});
