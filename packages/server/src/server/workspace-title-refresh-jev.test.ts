import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { createTestJevService, type TestJevServiceOptions } from "./jev/fake.js";
import type { WorkspaceTitleTrackerAgentSummary } from "./agent/agent-manager.js";
import { TITLE_REFRESH_DEFAULTS } from "./workspace-title-refresh-config.js";
import {
  buildTitleRefreshState,
  createTitleRefreshRecorder,
  decideTitleRefresh,
  type TitleRefreshCounters,
  type TitleRefreshSession,
} from "./workspace-title-refresh-jev.js";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const HOUR = 3_600_000;

/**
 * `createTestJevService` leaves `resolveAgentCwds` unset, so a scoped `agentIds` entry has no
 * record and the D7 check excludes it (docs/jev.md, "The D7 exclusion" — an unknown agent id
 * cannot be checked). Every test here scopes by the fixture's known agents, so it stands in for
 * a real daemon that has them.
 */
function createJevForTest(options: TestJevServiceOptions = {}) {
  return createTestJevService({
    ...options,
    service: { resolveAgentCwds: async () => [], ...options.service },
  });
}

function agent(
  overrides: Partial<WorkspaceTitleTrackerAgentSummary> = {},
): WorkspaceTitleTrackerAgentSummary {
  return {
    id: "agent-1",
    workspaceId: "wks_checkout",
    internal: false,
    lifecycle: "running",
    title: "Debug Paseo daemon CPU spike",
    lastActivitySummary: "Read daemon.log",
    lastActivityAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<WorkspaceTitleTrackerAgentSummary> = {}): TitleRefreshSession {
  return {
    agent: agent(overrides),
    conversation: {
      firstUserMessage: "Why is the daemon at 100% CPU?",
      recentUserMessages: ["Now add a CPU profile endpoint", "Ship the profile endpoint"],
      lastAssistantMessage: "The profile endpoint is in and its test passes.",
    },
  };
}

function counters(overrides: Partial<TitleRefreshCounters> = {}): TitleRefreshCounters {
  return {
    userTurnsSinceLook: 1,
    userTurnsSinceGeneration: 1,
    lastGenerationAtMs: NOW - HOUR,
    ...overrides,
  };
}

const baseInput = {
  config: TITLE_REFRESH_DEFAULTS,
  nowMs: NOW,
  currentTitle: "Debug Paseo daemon CPU spike",
  branch: "main",
  // A real, non-git directory: the D7 check's git-signal lookup treats a nonexistent path's
  // spawn error as an exclusion signal, which would make every non-D7 test here excluded too.
  cwd: os.tmpdir(),
  sessions: [session()],
};

describe("decideTitleRefresh", () => {
  it("skips without asking JEV when no new user turn happened", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ userTurnsSinceLook: 0 }),
    });
    expect(decision).toMatchObject({ generate: false, action: "no-new-activity" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("asks JEV on the first look after first sight; there is no separate anchoring look", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ lastGenerationAtMs: NOW - 31 * 60_000 }),
    });
    expect(decision).toMatchObject({ generate: true, action: "jev-stale" });
  });

  it("regenerates when JEV scores the title stale", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({ ...baseInput, jev, counters: counters() });
    expect(decision).toMatchObject({
      generate: true,
      action: "jev-stale",
      gatedByJev: true,
      score: 3,
    });
    expect(jev.transport.calls).toHaveLength(1);
  });

  it("skips the generation call when JEV scores the title still fitting", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
    const decision = await decideTitleRefresh({ ...baseInput, jev, counters: counters() });
    expect(decision).toMatchObject({
      generate: false,
      action: "jev-fits",
      gatedByJev: true,
      score: 0,
    });
    expect(jev.transport.calls).toHaveLength(1);
  });

  it("a low-confidence answer falls to the cadence", async () => {
    const jev = createJevForTest({
      answers: { fit: { type: "score", score: 0, confidence: 0.3 } },
    });
    const notReady = await decideTitleRefresh({ ...baseInput, jev, counters: counters() });
    expect(notReady).toMatchObject({
      generate: false,
      action: "cadence-not-ready",
      gatedByJev: false,
      reason: "low-confidence",
    });
    const ready = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({
        userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000,
      }),
    });
    // A confident "fits" would have skipped this; a 0.3 one cannot.
    expect(ready).toMatchObject({ generate: true, action: "cadence", reason: "low-confidence" });
  });

  it("falls back to the cadence when the JEV gate is switched off, not ready", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      config: { ...TITLE_REFRESH_DEFAULTS, enabled: false },
      counters: counters({
        userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns - 1,
        lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
      }),
    });
    expect(decision).toMatchObject({ generate: false, action: "cadence-not-ready" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("falls back to the cadence when JEV is unavailable, ready", async () => {
    const jev = createJevForTest({
      config: { titleRefresh: { enabled: false } },
      answers: { fit: { type: "score", score: 3 } },
    });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({
        userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
      }),
    });
    expect(decision).toMatchObject({ generate: true, action: "cadence", outcome: "unavailable" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("sends nothing to JEV for a D7-excluded workspace and uses the cadence", async () => {
    // Nothing is excluded by default since 2026-10-02, so the test configures the marker it needs.
    const jev = createJevForTest({
      answers: { fit: { type: "score", score: 3 } },
      config: { excludeTextMarkers: ["acme-internal"] },
    });
    const excluded = [
      session({ lastActivitySummary: "Read ~/acme-internal/android/build.gradle" }),
    ];
    const early = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters(),
      sessions: excluded,
    });
    expect(early).toMatchObject({
      generate: false,
      action: "cadence-not-ready",
      gatedByJev: false,
      outcome: "unavailable",
      reason: "excluded",
    });
    const due = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({
        userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000,
      }),
      sessions: excluded,
    });
    expect(due).toMatchObject({ generate: true, action: "cadence", reason: "excluded" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("regenerates at the turn ceiling without asking JEV, even mid-streak of fits", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
    const decide = vi.spyOn(jev, "decide");
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.ceilingUserTurns }),
    });
    expect(decision).toMatchObject({ generate: true, action: "ceiling", gatedByJev: false });
    expect(decide).not.toHaveBeenCalled();
  });

  it("regenerates at the hour ceiling without asking JEV", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
    const decide = vi.spyOn(jev, "decide");
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.ceilingHours * HOUR }),
    });
    expect(decision).toMatchObject({ generate: true, action: "ceiling" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("falls back to the cadence with no JEV wired at all", async () => {
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev: null,
      counters: counters({
        userTurnsSinceGeneration: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastGenerationAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
      }),
    });
    expect(decision).toMatchObject({ generate: true, action: "cadence", gatedByJev: false });
  });
});

describe("buildTitleRefreshState", () => {
  it("judges the title against the conversation, not the titles it was generated from", () => {
    const state = buildTitleRefreshState({
      currentTitle: "Daemon CPU spike",
      branch: "main",
      sessions: [session({ title: "Debug Paseo daemon CPU spike" })],
    });
    expect(state).toEqual({
      current_title: "Daemon CPU spike",
      branch: "main",
      sessions: [
        {
          status: "running",
          first_request: "Why is the daemon at 100% CPU?",
          recent_requests: ["Now add a CPU profile endpoint", "Ship the profile endpoint"],
          doing: "Read daemon.log",
        },
      ],
      latest_reply: "The profile endpoint is in and its test passes.",
    });
    expect(JSON.stringify(state)).not.toContain("Debug Paseo daemon CPU spike");
  });

  it("trims long messages", () => {
    const long = "x".repeat(5_000);
    const state = buildTitleRefreshState({
      currentTitle: "t",
      branch: null,
      sessions: [
        {
          agent: agent(),
          conversation: {
            firstUserMessage: long,
            recentUserMessages: [long],
            lastAssistantMessage: long,
          },
        },
      ],
    });
    expect(JSON.stringify(state).length).toBeLessThan(5_000);
  });
});

describe("createTitleRefreshRecorder", () => {
  async function record(action: "jev-fits" | "jev-stale") {
    const notes: unknown[] = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), "title-refresh-recorder-"));
    const recorder = createTitleRefreshRecorder({
      jev: { decisions: { record: (note: unknown) => notes.push(note) } } as never,
      filePath: path.join(dir, "title-refresh.jsonl"),
      logger: pino({ level: "silent" }),
    });
    recorder(
      {
        workspaceId: "wks_checkout",
        action,
        gatedByJev: true,
        outcome: "answered",
        callId: "call-1",
        reason: null,
        score: action === "jev-fits" ? 0 : 3,
        confidence: 0.9,
        staleScoreThreshold: 2,
        generationCalled: action === "jev-stale",
        userTurnsSinceLook: 1,
        userTurnsSinceGeneration: 1,
        minutesSinceGeneration: 31,
      },
      { agentId: "agent-1", currentTitle: "Daemon CPU spike" },
    );
    // The jsonl append is asynchronous.
    const file = await vi.waitFor(() =>
      readFileSync(path.join(dir, "title-refresh.jsonl"), "utf8"),
    );
    return { notes, file };
  }

  it("records a fits answer as applied: JEV skipped a call code would have made", async () => {
    const { notes, file } = await record("jev-fits");
    expect(notes).toEqual([
      expect.objectContaining({
        applied: true,
        mode: "live",
        wouldBe: "regenerate title",
        confidence: 0.9,
      }),
    ]);
    expect(JSON.parse(file.trim())).toMatchObject({ action: "jev-fits", generationCalled: false });
  });

  it("records a stale answer as not applied: the call happened as it would have anyway", async () => {
    const { notes } = await record("jev-stale");
    expect(notes).toEqual([expect.objectContaining({ applied: false, mode: "live" })]);
  });
});
