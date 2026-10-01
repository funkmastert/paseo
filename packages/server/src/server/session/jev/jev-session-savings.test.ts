import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "../../authorization/operation-permissions.js";
import { createTestJevService } from "../../jev/fake.js";
import type { JevSavingsLedger } from "../../jev/savings.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { JevSession } from "./jev-session.js";

// Both `jev.savings.*` RPCs over the real JEV service and the fake transport (docs/jev.md,
// "Savings"): a question asked through `jev.ask` lands in the ledger and comes back out.

type SummaryResponse = Extract<SessionOutboundMessage, { type: "jev.savings.summary.response" }>;
type EventsResponse = Extract<SessionOutboundMessage, { type: "jev.savings.events.response" }>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness() {
  const home = mkdtempSync(path.join(os.tmpdir(), "jev-savings-session-"));
  const service = createTestJevService({
    paseoHome: home,
    homeDir: home,
    answers: { answer: { type: "noul", noul: 0.82 } },
  });
  await service.start();
  cleanups.push(async () => {
    await service.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const emitted: SessionOutboundMessage[] = [];
  const session = new JevSession({
    host: { emit: (msg) => emitted.push(msg) },
    service,
    logger: { warn: vi.fn() },
  });
  return { service, session, emitted };
}

describe("jev.savings.* over the real service", () => {
  it("an Ask JEV question is an involvement with no token figure", async () => {
    const { session, emitted } = await harness();
    await session.handleAsk({
      type: "jev.ask.request",
      requestId: "ask-1",
      context: "npm run build exits 2 on main",
      question: { type: "noul", instructions: "Is the build still broken?" },
    });

    await session.handleSavingsSummary({
      type: "jev.savings.summary.request",
      requestId: "s-1",
      range: "today",
    });
    await session.handleSavingsEvents({
      type: "jev.savings.events.request",
      requestId: "e-1",
      range: "today",
    });

    const summary = (
      emitted.find((m) => m.type === "jev.savings.summary.response") as SummaryResponse
    ).payload;
    expect(summary.requestId).toBe("s-1");
    expect(summary.summary.live.involvements).toBe(1);
    expect(summary.summary.live.tokensSaved).toBe(0);
    expect(summary.summary.features.find((f) => f.feature === "askJev")).toMatchObject({
      benefit: "none",
      asked: 1,
      state: "live",
    });
    expect(summary.summary.jevSpend.calls).toBe(1);

    const events = (emitted.find((m) => m.type === "jev.savings.events.response") as EventsResponse)
      .payload;
    expect(events.events).toMatchObject([
      {
        feature: "askJev",
        mode: "live",
        outcome: "answered",
        benefit: "none",
        tokensSavedEstimate: null,
      },
    ]);
    expect(events.nextCursor).toBeNull();
  });

  it("an unknown range throws, so the session answers with an rpc_error", async () => {
    const { session } = await harness();

    await expect(
      session.handleSavingsSummary({
        type: "jev.savings.summary.request",
        requestId: "s-1",
        range: "month",
      }),
    ).rejects.toThrow(/unknown range/);
  });

  it("a service whose savings sink cannot read refuses rather than answering zeros", async () => {
    const { service } = await harness();
    const session = new JevSession({
      host: { emit: vi.fn() },
      service: {
        ...service,
        savings: {
          record: () => "",
          settle: vi.fn(),
          validate: vi.fn(),
          countNotAsked: vi.fn(),
          noteRead: vi.fn(),
        },
      },
      logger: { warn: vi.fn() },
    });

    await expect(
      session.handleSavingsEvents({
        type: "jev.savings.events.request",
        requestId: "e-1",
        range: "7d",
      }),
    ).rejects.toThrow(/not available/);
  });

  it("the events are filtered to the workspaces the caller may read (review m4)", async () => {
    const { service } = await harness();
    const ledger = service.savings as JevSavingsLedger;
    for (const [callId, workspaceId] of [
      ["c1", "ws-1"],
      ["c2", "ws-2"],
      ["c3", null],
    ] as const) {
      ledger.recordObserved(
        {
          feature: "askJev",
          callSite: "jev.ask",
          callId,
          workspaceId,
          involvement: "a question",
          decision: { did: "answered", wouldBe: null, changed: false },
          facts: {},
        },
        { mode: "live", outcome: "answered", jevCostUsd: null },
      );
    }
    const emitted: SessionOutboundMessage[] = [];
    const scoped = new JevSession({
      host: { emit: (msg) => emitted.push(msg) },
      service,
      logger: { warn: vi.fn() },
      permittedWorkspaceIds: () => ["ws-1"],
    });
    await scoped.handleSavingsEvents({
      type: "jev.savings.events.request",
      requestId: "e-1",
      range: "today",
    });
    const unscoped = new JevSession({
      host: { emit: (msg) => emitted.push(msg) },
      service,
      logger: { warn: vi.fn() },
    });
    await unscoped.handleSavingsEvents({
      type: "jev.savings.events.request",
      requestId: "e-2",
      range: "today",
    });

    const pages = emitted.filter(
      (m): m is EventsResponse => m.type === "jev.savings.events.response",
    );
    expect(pages[0]?.payload.events.map((e) => e.workspaceId)).toEqual(["ws-1"]);
    expect(pages[1]?.payload.events).toHaveLength(3);
  });

  it("the summary needs daemon.read and the events workspace.read", () => {
    expect(requiredPermissionForInbound("jev.savings.summary.request")).toBe("daemon.read");
    const outbound = (type: string) =>
      requiredPermissionForOutbound({ type } as SessionOutboundMessage);
    expect(outbound("jev.savings.summary.response")).toBe("daemon.read");
    expect(requiredPermissionForInbound("jev.savings.events.request")).toBe("workspace.read");
    expect(outbound("jev.savings.events.response")).toBe("workspace.read");
  });
});
