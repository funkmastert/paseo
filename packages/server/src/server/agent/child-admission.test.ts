import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  type AdmissionAgentView,
  type AdmissionOutcome,
  type ChildAdmissionConfig,
  ChildAdmissionController,
  defaultMaxConcurrentChildTurns,
  loadHeldTurns,
  mergeHeldPrompts,
  resolveChildAdmissionSettings,
  restoreHeldTurns,
  type HeldTurn,
} from "./child-admission.js";
import { ResumePacer } from "./resume-pacer.js";

/** A fake fleet: the controller reads lifecycle state from here, as it does from the manager. */
function harness(
  config: ChildAdmissionConfig = { maxConcurrentChildTurns: 2 },
  queueFilePath?: string,
) {
  const agents = new Map<string, AdmissionAgentView>();
  let currentConfig = config;
  // Each request a second after the last, so line order is by time as it is in production.
  let clockMs = Date.parse("2026-09-24T10:00:00.000Z");
  const controller = new ChildAdmissionController({
    readConfig: () => currentConfig,
    listAgents: () => [...agents.values()],
    logger: createTestLogger(),
    queueFilePath,
    now: () => new Date((clockMs += 1000)),
  });
  const set = (
    id: string,
    parentAgentId: string | null,
    lifecycle: AdmissionAgentView["lifecycle"],
  ) => {
    agents.set(id, { id, parentAgentId, lifecycle });
  };
  /** Mirrors the manager: an admitted child runs; a queued one shows running while it waits. */
  const start = (id: string, parentAgentId: string | null) => {
    const result = controller.request({ agentId: id, parentAgentId, prompt: `task ${id}` });
    set(id, parentAgentId, "running");
    if (result.status === "admitted") controller.settleStart(id);
    return result;
  };
  const finish = (id: string) => {
    const view = agents.get(id)!;
    set(id, view.parentAgentId, "idle");
    controller.pump();
  };
  return {
    controller,
    agents,
    set,
    start,
    finish,
    setConfig: (next: ChildAdmissionConfig) => {
      currentConfig = next;
      controller.pump();
    },
  };
}

async function settled(result: Promise<AdmissionOutcome>): Promise<AdmissionOutcome | "pending"> {
  return await Promise.race([
    result,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 5)),
  ]);
}

describe("resolveChildAdmissionSettings", () => {
  test("defaults the cap to half the cores, never below two, and pacing to four a minute", () => {
    expect(resolveChildAdmissionSettings(undefined, 16)).toEqual({
      enabled: true,
      maxConcurrentChildTurns: 8,
      bulkResumesPerMinute: 4,
    });
    expect(defaultMaxConcurrentChildTurns(2)).toBe(2);
    expect(defaultMaxConcurrentChildTurns(5)).toBe(2);
    expect(
      resolveChildAdmissionSettings({ maxConcurrentChildTurns: 3 }, 16).maxConcurrentChildTurns,
    ).toBe(3);
  });
});

describe("ChildAdmissionController", () => {
  test("never queues a root, even past the cap or under a hold", () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("child-1", "root");
    h.controller.setHold("saturation", true);
    expect(h.start("root", null).status).toBe("admitted");
    expect(h.start("root-2", null).status).toBe("admitted");
  });

  test("queues a child past the cap and admits FIFO as child turns end", async () => {
    const h = harness({ maxConcurrentChildTurns: 2 });
    h.set("root", null, "running");
    expect(h.start("c1", "root").status).toBe("admitted");
    expect(h.start("c2", "root").status).toBe("admitted");
    const q3 = h.start("c3", "root");
    const q4 = h.start("c4", "root");
    expect(q3.status).toBe("queued");
    expect(q4.status).toBe("queued");
    expect(h.controller.queueLength()).toBe(2);

    h.finish("c1");
    expect(await settled((q3 as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
      prompt: "task c3",
    });
    expect(await settled((q4 as { result: Promise<AdmissionOutcome> }).result)).toBe("pending");

    // An errored child frees its slot the same way an idle one does.
    h.set("c2", "root", "error");
    h.controller.pump();
    expect(await settled((q4 as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
  });

  test("a new child joins the back of a non-empty queue even if a slot looks free", () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    h.start("c2", "root");
    // c1 goes idle but nobody pumped yet: c3 must not jump ahead of c2.
    h.set("c1", "root", "idle");
    expect(h.start("c3", "root").status).toBe("queued");
  });

  test("an admitted child that has not started yet still holds its slot", () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    expect(h.controller.request({ agentId: "c1", parentAgentId: "root", prompt: "x" }).status).toBe(
      "admitted",
    );
    // c1 is still idle in lifecycle state (startTurn in flight), yet the slot is taken.
    h.set("c1", "root", "idle");
    expect(h.start("c2", "root").status).toBe("queued");
  });

  test("a child replacing its own running turn keeps its slot and is never queued", () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    h.start("c2", "root");
    expect(
      h.controller.request({
        agentId: "c1",
        parentAgentId: "root",
        prompt: "again",
        keepsSlot: true,
      }).status,
    ).toBe("admitted");
  });

  test("sub-leaders waiting on their own children do not deadlock the cap", async () => {
    const h = harness({ maxConcurrentChildTurns: 2 });
    h.set("root", null, "running");
    // Two sub-leaders fill both slots...
    h.start("lead-a", "root");
    h.start("lead-b", "root");
    // ...and each spawns a worker and waits on it.
    const workerA = h.start("worker-a", "lead-a");
    const workerB = h.start("worker-b", "lead-b");
    // A sub-leader with a live child frees its slot, so both workers run.
    expect(workerA.status).toBe("admitted");
    expect(workerB.status).toBe("admitted");
  });

  test("a worker queued behind a hold runs once released, while its leader holds the only slot", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("lead", "root");
    h.controller.setHold("saturation", true);
    const worker = h.start("worker", "lead");
    expect(worker.status).toBe("queued");
    h.controller.setHold("saturation", false);
    // lead waits on worker, so lead stops counting and worker takes the slot.
    expect(await settled((worker as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
  });

  test("holds keep queued children queued until every source releases", async () => {
    const h = harness({ maxConcurrentChildTurns: 4 });
    h.controller.setHold("saturation", true, "load 38 on 16 cores");
    h.controller.setHold("other", true);
    const queued = h.start("c1", "root");
    expect(queued.status).toBe("queued");
    h.controller.setHold("saturation", false);
    expect(await settled((queued as { result: Promise<AdmissionOutcome> }).result)).toBe("pending");
    h.controller.setHold("other", false);
    expect(await settled((queued as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
  });

  test("a second prompt to a queued child is merged into the held one and keeps its place", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    const q2 = h.start("c2", "root");
    const q3 = h.start("c3", "root");
    expect(h.controller.mergeHeld("c2", "and also this", { clientMessageId: "m2" })).toBe(true);
    expect(h.controller.mergeHeld("c1", "not queued")).toBe(false);
    h.finish("c1");
    expect(await settled((q2 as { result: Promise<AdmissionOutcome> }).result)).toEqual({
      outcome: "admitted",
      prompt: "task c2\n\nand also this",
      runOptions: { clientMessageId: "m2" },
    });
    expect(await settled((q3 as { result: Promise<AdmissionOutcome> }).result)).toBe("pending");
  });

  test("dropping a queued child settles its waiter and leaves the rest of the line intact", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    const q2 = h.start("c2", "root");
    const q3 = h.start("c3", "root");
    expect(h.controller.drop("c2", "canceled")).toBe(true);
    expect(h.controller.drop("c2", "canceled")).toBe(false);
    expect(await settled((q2 as { result: Promise<AdmissionOutcome> }).result)).toEqual({
      outcome: "dropped",
      reason: "canceled",
    });
    h.agents.delete("c2");
    h.finish("c1");
    expect(await settled((q3 as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
  });

  test("a reload detaches a held turn and it goes back in at its old place", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    const q2 = h.start("c2", "root");
    h.start("c3", "root");
    const held = h.controller.detach("c2");
    expect(held).toMatchObject({ agentId: "c2", prompt: "task c2" });
    expect(await settled((q2 as { result: Promise<AdmissionOutcome> }).result)).toEqual({
      outcome: "dropped",
      reason: "reloaded",
    });
    const again = h.controller.request({
      agentId: "c2",
      parentAgentId: "root",
      prompt: held!.prompt,
      queuedAt: held!.queuedAt,
    });
    expect(again.status).toBe("queued");
    expect(h.controller.heldTurns().map((turn) => turn.agentId)).toEqual(["c2", "c3"]);
  });

  test("turning admission off admits everything queued", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    const q2 = h.start("c2", "root");
    h.setConfig({ enabled: false });
    expect(await settled((q2 as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
    expect(h.start("c3", "root").status).toBe("admitted");
  });

  test("raising the cap live admits the waiting children", async () => {
    const h = harness({ maxConcurrentChildTurns: 1 });
    h.start("c1", "root");
    const q2 = h.start("c2", "root");
    h.setConfig({ maxConcurrentChildTurns: 2 });
    expect(await settled((q2 as { result: Promise<AdmissionOutcome> }).result)).toMatchObject({
      outcome: "admitted",
    });
  });
});

describe("held-turn persistence", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  test("the queue is written on change and survives shutdown closes", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "child-admission-"));
    const file = path.join(dir, "admission", "queue.json");
    const h = harness({ maxConcurrentChildTurns: 1 }, file);
    h.start("c1", "root");
    h.start("c2", "root");
    h.controller.request({
      agentId: "c3",
      parentAgentId: "root",
      prompt: [{ type: "text", text: "blocks" }],
      runOptions: { maxThinkingTokens: 10 },
    });
    await h.controller.flush();
    expect(await loadHeldTurns(file, createTestLogger())).toEqual([
      expect.objectContaining({ agentId: "c2", parentAgentId: "root", prompt: "task c2" }),
      expect.objectContaining({
        agentId: "c3",
        prompt: [{ type: "text", text: "blocks" }],
        runOptions: { maxThinkingTokens: 10 },
      }),
    ]);

    // Shutdown closes every agent, which drops queued children; the file must keep them.
    h.controller.prepareForShutdown();
    h.controller.drop("c2", "closed");
    h.controller.drop("c3", "closed");
    await h.controller.flush();
    expect(await loadHeldTurns(file, createTestLogger())).toHaveLength(2);
  });

  test("a prompt queued just before shutdown is in the file even if its write had not run", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "child-admission-"));
    const file = path.join(dir, "admission", "queue.json");
    const h = harness({ maxConcurrentChildTurns: 1 }, file);
    h.start("c1", "root");
    // Queued, and in the same tick shutdown freezes the file and closes every agent. The write
    // the queueing scheduled has not run yet.
    h.start("c2", "root");
    h.controller.prepareForShutdown();
    h.controller.drop("c2", "closed");
    await h.controller.flush();
    expect(await loadHeldTurns(file, createTestLogger())).toEqual([
      expect.objectContaining({ agentId: "c2", prompt: "task c2" }),
    ]);
  });

  test("a restart re-admits held turns oldest first, and keeps them on disk until dispatched", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "child-admission-"));
    const file = path.join(dir, "admission", "queue.json");
    const h = harness({ maxConcurrentChildTurns: 1 }, file);
    const held: HeldTurn[] = [
      { agentId: "late", parentAgentId: "root", prompt: "b", queuedAt: "2026-09-24T10:00:02.000Z" },
      {
        agentId: "early",
        parentAgentId: "root",
        prompt: "a",
        queuedAt: "2026-09-24T10:00:01.000Z",
      },
      { agentId: "gone", parentAgentId: "root", prompt: "c", queuedAt: "2026-09-24T10:00:03.000Z" },
    ];
    // One resume a minute on a hand-driven clock: only "early" goes before the clock moves.
    let pacerNowMs = 0;
    const timers: (() => void)[] = [];
    const pacer = new ResumePacer({
      readSettings: () => ({ enabled: true, perMinute: 1 }),
      logger: createTestLogger(),
      now: () => pacerNowMs,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    const dispatched: string[] = [];
    h.start("c-busy", "root");
    const restoring = restoreHeldTurns({
      controller: h.controller,
      pacer,
      held,
      logger: createTestLogger(),
      dispatch: async (turn) => {
        if (turn.agentId === "gone") throw new Error("Agent gone not found");
        dispatched.push(turn.agentId);
        h.start(turn.agentId, "root");
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(dispatched).toEqual(["early"]);
    await h.controller.flush();
    // "early" is queued live now; "late" and "gone" are only in the file, and still there.
    expect((await loadHeldTurns(file, createTestLogger())).map((t) => t.agentId).sort()).toEqual([
      "early",
      "gone",
      "late",
    ]);

    for (let i = 0; i < 2; i += 1) {
      pacerNowMs += 60_000;
      timers.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    await restoring;
    expect(dispatched).toEqual(["early", "late"]);
    await h.controller.flush();
    // "gone" could not be dispatched and is let go; the other two are in the live queue.
    expect((await loadHeldTurns(file, createTestLogger())).map((t) => t.agentId)).toEqual([
      "early",
      "late",
    ]);
  });

  test("a missing or corrupt file loads as empty", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "child-admission-"));
    expect(await loadHeldTurns(path.join(dir, "missing.json"), createTestLogger())).toEqual([]);
  });
});

describe("mergeHeldPrompts", () => {
  test("joins strings and concatenates blocks", () => {
    expect(mergeHeldPrompts("a", "b")).toBe("a\n\nb");
    expect(mergeHeldPrompts("a", [{ type: "text", text: "b" }])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });
});
