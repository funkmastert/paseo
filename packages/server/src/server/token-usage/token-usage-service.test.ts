import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionSource } from "./token-usage-attribution.js";
import { TokenUsageService, isTokenUsageEnabled } from "./token-usage-service.js";
import { TokenUsageStore } from "./token-usage-store.js";
import { FAKE_CLAUDE_SESSION, claudeAssistantLine } from "./test-utils/fixtures.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T13:30:00.000Z");

let tmp: string;
let projectDir: string;
let rootDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-service-"));
  projectDir = path.join(tmp, "projects", "-fake-project");
  rootDir = path.join(tmp, "home", "token-usage");
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeTranscript(sessionId: string, lines: string[]): Promise<void> {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`);
  const mtime = new Date(NOW - HOUR);
  await fs.utimes(filePath, mtime, mtime);
}

function createService(options?: {
  enabled?: () => boolean;
  records?: AgentSessionSource[];
  budgetMs?: number;
  store?: TokenUsageStore;
  firstSweepDelayMs?: number;
}) {
  return new TokenUsageService({
    rootDir,
    roots: [{ provider: "claude", dir: path.join(tmp, "projects") }],
    listAgentRecords: async () => options?.records ?? [],
    isEnabled: options?.enabled ?? (() => true),
    logger: { warn: vi.fn(), info: vi.fn() },
    now: () => NOW,
    firstSweepDelayMs: options?.firstSweepDelayMs,
    sweepIntervalMs: 60 * 60_000,
    scanner:
      options?.budgetMs === undefined
        ? undefined
        : { budgetMs: options.budgetMs, yieldEveryLines: 1 },
    store: options?.store,
  });
}

describe("TokenUsageService", () => {
  it("reads nothing and reports off while the config turns it off", async () => {
    await writeTranscript(FAKE_CLAUDE_SESSION, [claudeAssistantLine({ messageId: "m1" })]);
    const service = createService({ enabled: () => false });

    expect(await service.runSweep()).toBeNull();
    const breakdown = await service.getBreakdown("7d");
    await service.stop();

    expect(breakdown.rows).toEqual([]);
    expect(breakdown.coverage).toEqual({
      enabled: false,
      recordingSinceMs: null,
      backfill: { state: "off", filesDone: 0, filesTotal: 0 },
    });
    await expect(fs.stat(rootDir)).rejects.toThrow();
  });

  it("reports the backfill pending, then running with progress, then done", async () => {
    await writeTranscript(FAKE_CLAUDE_SESSION, [
      claudeAssistantLine({ messageId: "m1" }),
      claudeAssistantLine({ messageId: "m2" }),
    ]);
    await writeTranscript("other-session", [
      claudeAssistantLine({ messageId: "m3", sessionId: "other-session" }),
    ]);
    const service = createService({ budgetMs: 0 });

    expect((await service.getBreakdown("24h")).coverage.backfill.state).toBe("pending");
    await service.runSweep();
    expect((await service.getBreakdown("24h")).coverage).toEqual({
      enabled: true,
      recordingSinceMs: NOW,
      backfill: { state: "running", filesDone: 0, filesTotal: 2 },
    });
    for (let sweep = 0; sweep < 10; sweep += 1) await service.runSweep();
    const done = await service.getBreakdown("24h");
    await service.stop();

    expect(done.coverage.backfill).toEqual({ state: "done", filesDone: 2, filesTotal: 2 });
    expect(done.rows.reduce((sum, row) => sum + row.responses, 0)).toBe(3);
  });

  it("books a leader, a worker and an outside session", async () => {
    await writeTranscript("s-leader", [
      claudeAssistantLine({ messageId: "l1", sessionId: "s-leader" }),
    ]);
    await writeTranscript("s-worker", [
      claudeAssistantLine({ messageId: "w1", sessionId: "s-worker" }),
    ]);
    await writeTranscript("s-outside", [
      claudeAssistantLine({ messageId: "o1", sessionId: "s-outside" }),
    ]);
    const service = createService({
      records: [
        { id: "agent-leader", labels: {}, persistence: { sessionId: "s-leader" } },
        {
          id: "agent-worker",
          labels: { "paseo.parent-agent-id": "agent-leader" },
          runtimeInfo: { sessionId: "s-worker" },
        },
      ],
    });

    await service.runSweep();
    const breakdown = await service.getBreakdown("30d");
    await service.stop();

    expect(breakdown.rows.map((row) => row.role).sort()).toEqual(["leader", "outside", "worker"]);
  });

  it("attributes a session the daemon saw an agent use, after the agent's record moved on", async () => {
    await writeTranscript("s-earlier", [
      claudeAssistantLine({ messageId: "e1", sessionId: "s-earlier" }),
    ]);
    const service = createService();
    service.observeAgent({
      id: "agent-worker",
      labels: { "paseo.parent-agent-id": "agent-leader" },
      persistence: { sessionId: "s-earlier" },
    });

    await service.runSweep();
    const breakdown = await service.getBreakdown("24h");
    await service.stop();

    expect(breakdown.rows).toMatchObject([{ role: "worker", responses: 1 }]);
    const sessions = JSON.parse(await fs.readFile(path.join(rootDir, "sessions.json"), "utf8"));
    expect(sessions.sessions).toEqual([["s-earlier", "agent-worker", "agent-leader", NOW]]);
  });

  it("starts each range on the hour and counts only that range", async () => {
    const store = new TokenUsageStore({ rootDir, logger: { warn: vi.fn() } });
    await store.load();
    for (const ageMs of [HOUR, 3 * DAY, 20 * DAY]) {
      store.add({
        atMs: NOW - ageMs,
        provider: "claude",
        model: "claude-opus-5-5",
        role: "leader",
        input: 1,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        responses: 1,
      });
    }
    const service = createService({ store });

    const responses = async (range: "24h" | "7d" | "30d") => {
      const breakdown = await service.getBreakdown(range);
      return { start: breakdown.rangeStartMs, responses: breakdown.rows[0]?.responses };
    };

    expect(await responses("24h")).toEqual({
      start: Date.parse("2026-09-30T13:00:00.000Z"),
      responses: 1,
    });
    expect(await responses("7d")).toEqual({
      start: Date.parse("2026-09-24T13:00:00.000Z"),
      responses: 2,
    });
    expect(await responses("30d")).toEqual({
      start: Date.parse("2026-09-01T13:00:00.000Z"),
      responses: 3,
    });
    await service.stop();
  });

  it("sweeps on its own timer once started, and flushes on stop", async () => {
    await writeTranscript(FAKE_CLAUDE_SESSION, [claudeAssistantLine({ messageId: "m1" })]);
    const store = new TokenUsageStore({ rootDir, logger: { warn: vi.fn() }, flushIntervalMs: DAY });
    const service = createService({ store, firstSweepDelayMs: 0 });

    service.start();
    await vi.waitFor(async () => {
      expect((await service.getBreakdown("24h")).coverage.backfill.state).toBe("done");
    });
    await service.stop();

    const state = JSON.parse(await fs.readFile(path.join(rootDir, "state.json"), "utf8"));
    expect(state.buckets).toHaveLength(1);
  });
});

describe("isTokenUsageEnabled", () => {
  it("is on unless agents.tokenUsage.enabled is false", () => {
    expect(isTokenUsageEnabled(null)).toBe(true);
    expect(isTokenUsageEnabled({ agents: {} })).toBe(true);
    expect(isTokenUsageEnabled({ agents: { tokenUsage: { enabled: true } } })).toBe(true);
    expect(isTokenUsageEnabled({ agents: { tokenUsage: { enabled: false } } })).toBe(false);
  });
});
