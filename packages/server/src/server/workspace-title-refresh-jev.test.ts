import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { createTestJevService, type TestJevServiceOptions } from "./jev/fake.js";
import type { WorkspaceTitleTrackerAgentSummary } from "./agent/agent-manager.js";
import { TITLE_REFRESH_DEFAULTS } from "./workspace-title-refresh-config.js";
import { decideTitleRefresh, type TitleRefreshCounters } from "./workspace-title-refresh-jev.js";

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

function counters(overrides: Partial<TitleRefreshCounters> = {}): TitleRefreshCounters {
  return { userTurnsSinceCheck: 1, lastAttemptAtMs: NOW - HOUR, ...overrides };
}

const baseInput = {
  config: TITLE_REFRESH_DEFAULTS,
  nowMs: NOW,
  currentTitle: "Debug Paseo daemon CPU spike",
  branch: "main",
  // A real, non-git directory: the D7 check's git-signal lookup treats a nonexistent path's
  // spawn error as an exclusion signal, which would make every non-D7 test here excluded too.
  cwd: os.tmpdir(),
  agents: [agent()],
};

describe("decideTitleRefresh", () => {
  it("anchors on the first look instead of judging a since-forever elapsed time", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ lastAttemptAtMs: null }),
    });
    expect(decision).toMatchObject({ generate: false, action: "anchored" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("skips without asking JEV when no new user turn happened", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ userTurnsSinceCheck: 0 }),
    });
    expect(decision).toMatchObject({ generate: false, action: "no-new-activity" });
    expect(jev.transport.calls).toHaveLength(0);
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

  it("falls back to the cadence when JEV is unavailable, not ready", async () => {
    const jev = createJevForTest({
      config: { titleRefresh: { enabled: false } },
      answers: { fit: { type: "score", score: 3 } },
    });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({
        userTurnsSinceCheck: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns - 1,
        lastAttemptAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
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
        userTurnsSinceCheck: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastAttemptAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
      }),
    });
    expect(decision).toMatchObject({ generate: true, action: "cadence" });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("sends nothing to JEV for a D7-excluded workspace and generates like today", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters(),
      agents: [agent({ lastActivitySummary: "Read ~/mobile-worktrees/android/build.gradle" })],
    });
    expect(decision).toMatchObject({
      generate: true,
      action: "d7-excluded",
      gatedByJev: false,
      outcome: "unavailable",
      reason: "excluded",
    });
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("regenerates at the ceiling without asking JEV, even mid-streak of fits", async () => {
    const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
    const decide = vi.spyOn(jev, "decide");
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev,
      counters: counters({ userTurnsSinceCheck: TITLE_REFRESH_DEFAULTS.ceilingUserTurns }),
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
      counters: counters({
        lastAttemptAtMs: NOW - TITLE_REFRESH_DEFAULTS.ceilingHours * HOUR,
      }),
    });
    expect(decision).toMatchObject({ generate: true, action: "ceiling" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("falls back to the cadence with no JEV wired at all", async () => {
    const decision = await decideTitleRefresh({
      ...baseInput,
      jev: null,
      counters: counters({
        userTurnsSinceCheck: TITLE_REFRESH_DEFAULTS.cadenceMinUserTurns,
        lastAttemptAtMs: NOW - TITLE_REFRESH_DEFAULTS.cadenceMinMinutes * 60_000 * 2,
      }),
    });
    expect(decision).toMatchObject({ generate: true, action: "cadence", gatedByJev: false });
  });
});
