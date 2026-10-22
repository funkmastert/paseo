import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { IdleTurnOutcome, LeaderCompactionAgentSummary } from "../agent/agent-manager.js";
import { AgentLeaderCompactionMonitor } from "../agent-leader-compaction-monitor.js";
import { CompactionLedgerService } from "./compaction-ledger-service.js";
import { CompactionLedgerStore } from "./compaction-ledger-store.js";

/**
 * Wires a real AgentLeaderCompactionMonitor to a real CompactionLedgerService and store, to prove
 * the observer hook (U1), the service (U3) and the store (U2) actually fit together end to end —
 * not just each piece's own unit tests against synthetic inputs.
 */

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeAgents {
  agents: LeaderCompactionAgentSummary[] = [];
  outcomes: IdleTurnOutcome[] = [];
  onTurn: (prompt: string) => void = () => undefined;

  listAgentsForLeaderCompaction(): LeaderCompactionAgentSummary[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  startTurnIfIdle(agentId: string, prompt: AgentPromptInput): Promise<IdleTurnOutcome> | null {
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (!agent || agent.lifecycle !== "idle" || agent.busy) return null;
    this.onTurn(String(prompt));
    return Promise.resolve(this.outcomes.shift() ?? { status: "completed", finalText: "" });
  }

  subscribeOperatorSignals(): () => void {
    return () => undefined;
  }
}

function leader(
  overrides: Partial<LeaderCompactionAgentSummary> = {},
): LeaderCompactionAgentSummary {
  return {
    id: "leader-1",
    provider: "claude",
    sessionFamily: "claude",
    internal: false,
    isDelegated: false,
    lifecycle: "idle",
    busy: false,
    pendingPermissionCount: 0,
    contextWindowUsedTokens: 612_000,
    title: "Ship the thing",
    totalTokens: 1_000_000,
    steersAccepted: 0,
    ...overrides,
  };
}

describe("CompactionLedgerService wired to a real AgentLeaderCompactionMonitor", () => {
  test("a scripted prepare/compact/restore cycle produces one closed, measured row", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "compaction-ledger-wiring-"));
    try {
      const store = new CompactionLedgerStore({ rootDir, logger });
      await store.load();
      const service = new CompactionLedgerService({ store });

      const fake = new FakeAgents();
      fake.agents = [leader()];
      fake.outcomes = [
        { status: "completed", finalText: "GOAL: ship it." },
        { status: "completed", finalText: "" },
        { status: "completed", finalText: "restored" },
      ];
      fake.onTurn = (prompt) => {
        if (prompt.startsWith("/compact")) {
          fake.agents = [leader({ contextWindowUsedTokens: 31_000, totalTokens: 1_002_000 })];
        } else if (prompt.includes("step 3 of 3")) {
          fake.agents = [leader({ contextWindowUsedTokens: 31_000, totalTokens: 1_002_500 })];
        }
      };

      const monitor = new AgentLeaderCompactionMonitor({
        agentManager: fake,
        pushNotificationSender: { send: async () => undefined },
        serverId: "server-1",
        readDaemonConfig: () => ({ leaderCompaction: { enabled: true } }),
        logger,
        episodeObserver: service,
      });

      await monitor.tick();
      await monitor.settle();
      await monitor.tick();
      await monitor.settle();
      await monitor.tick();
      await monitor.settle();

      const rows = service.list({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentId: "leader-1",
        outcome: "done",
        source: "monitor",
        contextBeforeTokens: 612_000,
        contextAfterTokens: 31_000,
      });
      expect(rows[0]?.steps.map((step) => [step.step, step.costWeightedTokens])).toEqual([
        ["prepare", 0],
        ["compact", 2_000],
        ["restore", 500],
      ]);
      expect(rows[0]?.costWeightedTokens).toBe(2_500);
      expect(rows[0]?.costBasis).toBe("measured");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
