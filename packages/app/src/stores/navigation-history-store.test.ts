import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavHistoryEntry, NavigationHistoryReplayDeps } from "./navigation-history-store";
import {
  canGoBack,
  canGoForward,
  goBack,
  goBackTo,
  goForward,
  NAVIGATION_HISTORY_MAX_ENTRIES,
  pruneWorkspace,
  recordNavigationHistory,
  recordNavigationHistoryUnlessReplay,
  useNavigationHistoryStore,
} from "./navigation-history-store";

function entry(workspaceId: string, serverId = "server-1"): NavHistoryEntry {
  return { serverId, workspaceId };
}

function noop(): void {
  // Swallows the expected "replay failed; history left unchanged" log so the rollback tests
  // don't spam the console.
}

function createDeps(overrides: Partial<NavigationHistoryReplayDeps> = {}) {
  const replayed: NavHistoryEntry[] = [];
  const deps: NavigationHistoryReplayDeps = {
    isEntryValid: () => true,
    replay: (target) => replayed.push(target),
    ...overrides,
  };
  return { deps, replayed };
}

beforeEach(() => {
  useNavigationHistoryStore.setState({ backStack: [], forwardStack: [] });
});

describe("navigation history store", () => {
  it("pushes a distinct navigation onto the back stack", () => {
    recordNavigationHistory(entry("a"));
    recordNavigationHistory(entry("b"));

    expect(useNavigationHistoryStore.getState().backStack).toEqual([entry("a"), entry("b")]);
    expect(canGoBack(useNavigationHistoryStore.getState())).toBe(true);
  });

  it("drops a consecutive duplicate push", () => {
    recordNavigationHistory(entry("a"));
    recordNavigationHistory(entry("a"));

    expect(useNavigationHistoryStore.getState().backStack).toEqual([entry("a")]);
  });

  it("does not drop a duplicate that isn't consecutive", () => {
    recordNavigationHistory(entry("a"));
    recordNavigationHistory(entry("b"));
    recordNavigationHistory(entry("a"));

    expect(useNavigationHistoryStore.getState().backStack).toEqual([
      entry("a"),
      entry("b"),
      entry("a"),
    ]);
  });

  it("caps the back stack at the max entry count", () => {
    for (let i = 0; i < NAVIGATION_HISTORY_MAX_ENTRIES + 10; i += 1) {
      recordNavigationHistory(entry(`workspace-${i}`));
    }

    const { backStack } = useNavigationHistoryStore.getState();
    expect(backStack).toHaveLength(NAVIGATION_HISTORY_MAX_ENTRIES);
    // The oldest entries were dropped from the front; the most recent survive.
    expect(backStack.at(-1)).toEqual(entry(`workspace-${NAVIGATION_HISTORY_MAX_ENTRIES + 9}`));
    expect(backStack.at(0)).toEqual(entry("workspace-10"));
  });

  it("clears the forward stack on a new navigation", () => {
    recordNavigationHistory(entry("a"));
    recordNavigationHistory(entry("b"));
    const { deps } = createDeps();
    goBack(deps);
    expect(canGoForward(useNavigationHistoryStore.getState())).toBe(true);

    recordNavigationHistory(entry("c"));

    expect(useNavigationHistoryStore.getState().forwardStack).toEqual([]);
    expect(canGoForward(useNavigationHistoryStore.getState())).toBe(false);
  });

  it("removes entries belonging to a pruned workspace from both stacks", () => {
    recordNavigationHistory(entry("a"));
    recordNavigationHistory(entry("b"));
    recordNavigationHistory(entry("c"));
    goBack(createDeps().deps);
    goBack(createDeps().deps);

    pruneWorkspace("server-1:b");

    const state = useNavigationHistoryStore.getState();
    expect(state.backStack.some((e) => e.workspaceId === "b")).toBe(false);
    expect(state.forwardStack.some((e) => e.workspaceId === "b")).toBe(false);
  });

  it("reports canGoBack false with zero or one entries recorded", () => {
    expect(canGoBack(useNavigationHistoryStore.getState())).toBe(false);
    recordNavigationHistory(entry("a"));
    expect(canGoBack(useNavigationHistoryStore.getState())).toBe(false);
  });

  describe("back/forward round trip", () => {
    it("walks back then forward through recorded history", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));

      const { deps: backDeps, replayed: backReplayed } = createDeps();
      expect(goBack(backDeps)).toBe(true);
      expect(backReplayed).toEqual([entry("b")]);
      expect(canGoForward(useNavigationHistoryStore.getState())).toBe(true);

      const { deps: backDeps2, replayed: backReplayed2 } = createDeps();
      expect(goBack(backDeps2)).toBe(true);
      expect(backReplayed2).toEqual([entry("a")]);
      expect(canGoBack(useNavigationHistoryStore.getState())).toBe(false);

      const { deps: forwardDeps, replayed: forwardReplayed } = createDeps();
      expect(goForward(forwardDeps)).toBe(true);
      expect(forwardReplayed).toEqual([entry("b")]);

      const { deps: forwardDeps2, replayed: forwardReplayed2 } = createDeps();
      expect(goForward(forwardDeps2)).toBe(true);
      expect(forwardReplayed2).toEqual([entry("c")]);
      expect(canGoForward(useNavigationHistoryStore.getState())).toBe(false);
    });

    it("returns false and leaves state untouched when there's nothing to go back to", () => {
      recordNavigationHistory(entry("a"));
      const before = useNavigationHistoryStore.getState();

      const { deps, replayed } = createDeps();
      expect(goBack(deps)).toBe(false);
      expect(replayed).toEqual([]);
      expect(useNavigationHistoryStore.getState()).toEqual(before);
    });

    it("returns false when there's nothing to go forward to", () => {
      recordNavigationHistory(entry("a"));
      const { deps, replayed } = createDeps();

      expect(goForward(deps)).toBe(false);
      expect(replayed).toEqual([]);
    });
  });

  describe("recordNavigationHistoryUnlessReplay", () => {
    // This is the choke-point guard `navigateToWorkspace` calls on every
    // navigation, real or replayed -- see
    // docs/plans/2026-09-12-001-feat-global-back-history-plan.md's
    // "Integration -- replay actions, don't push routes".
    it("records a real (non-replay) navigation", () => {
      recordNavigationHistoryUnlessReplay({ serverId: "server-1", workspaceId: "a" });

      expect(useNavigationHistoryStore.getState().backStack).toEqual([entry("a")]);
    });

    it("does not record when fromHistoryReplay is set", () => {
      recordNavigationHistoryUnlessReplay({ serverId: "server-1", workspaceId: "a" });

      recordNavigationHistoryUnlessReplay({
        serverId: "server-1",
        workspaceId: "b",
        fromHistoryReplay: true,
      });

      expect(useNavigationHistoryStore.getState().backStack).toEqual([entry("a")]);
    });

    it("a full back-then-forward round trip never grows the stacks", () => {
      // The scenario the flag exists to prevent: without it, replaying "a" on
      // Back would record "a" again, corrupting the stacks on every trip.
      recordNavigationHistoryUnlessReplay({ serverId: "server-1", workspaceId: "a" });
      recordNavigationHistoryUnlessReplay({ serverId: "server-1", workspaceId: "b" });

      const { deps: backDeps } = createDeps({
        replay: (replayedEntry) =>
          recordNavigationHistoryUnlessReplay({ ...replayedEntry, fromHistoryReplay: true }),
      });
      goBack(backDeps);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a")],
        forwardStack: [entry("b")],
      });

      const { deps: forwardDeps } = createDeps({
        replay: (replayedEntry) =>
          recordNavigationHistoryUnlessReplay({ ...replayedEntry, fromHistoryReplay: true }),
      });
      goForward(forwardDeps);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a"), entry("b")],
        forwardStack: [],
      });
    });
  });

  describe("goBackTo", () => {
    it("with depth 1 behaves exactly like a single goBack", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      const before = useNavigationHistoryStore.getState();

      const { deps, replayed } = createDeps();
      expect(goBackTo(1, deps)).toBe(true);
      expect(replayed).toEqual([entry("b")]);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a"), entry("b")],
        forwardStack: [entry("c")],
      });

      // Sanity check against calling goBack() the same number of times on fresh state.
      useNavigationHistoryStore.setState(before);
      goBack(createDeps().deps);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a"), entry("b")],
        forwardStack: [entry("c")],
      });
    });

    it("jumps multiple entries in one call, moving each one passed over to the forward stack", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      recordNavigationHistory(entry("d"));

      const { deps, replayed } = createDeps();
      expect(goBackTo(3, deps)).toBe(true);
      expect(replayed).toEqual([entry("a")]);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a")],
        // Pushed in the order goBack() would bump them off one call at a time: current first,
        // then each intermediate stop.
        forwardStack: [entry("d"), entry("c"), entry("b")],
      });
    });

    it("matches calling goBack() the same number of times in a row", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      recordNavigationHistory(entry("d"));
      goBack(createDeps().deps);
      goBack(createDeps().deps);
      const viaRepeatedGoBack = useNavigationHistoryStore.getState();

      useNavigationHistoryStore.setState({
        backStack: [entry("a"), entry("b"), entry("c"), entry("d")],
        forwardStack: [],
      });
      goBackTo(2, createDeps().deps);

      expect(useNavigationHistoryStore.getState()).toEqual(viaRepeatedGoBack);
    });

    it("skips and discards stale entries along the way without counting them toward depth", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b")); // stale
      recordNavigationHistory(entry("c"));
      recordNavigationHistory(entry("d"));

      const { deps, replayed } = createDeps({
        isEntryValid: (candidate) => candidate.workspaceId !== "b",
      });
      // Depth 2 should reach "a" (the second *valid* entry behind "d"), skipping "b" entirely.
      expect(goBackTo(2, deps)).toBe(true);
      expect(replayed).toEqual([entry("a")]);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a")],
        forwardStack: [entry("d"), entry("c")],
      });
    });

    it("stops short and still applies the hops it could complete when depth exceeds history", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));

      const { deps, replayed } = createDeps();
      expect(goBackTo(5, deps)).toBe(true);
      expect(replayed).toEqual([entry("a")]);
      expect(useNavigationHistoryStore.getState()).toEqual({
        backStack: [entry("a")],
        forwardStack: [entry("b")],
      });
    });

    it("returns false and leaves state untouched when there's nothing to go back to", () => {
      recordNavigationHistory(entry("a"));
      const before = useNavigationHistoryStore.getState();

      const { deps, replayed } = createDeps();
      expect(goBackTo(1, deps)).toBe(false);
      expect(replayed).toEqual([]);
      expect(useNavigationHistoryStore.getState()).toEqual(before);
    });

    it("rejects a non-positive or non-integer depth", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));

      const { deps, replayed } = createDeps();
      expect(goBackTo(0, deps)).toBe(false);
      expect(goBackTo(-1, deps)).toBe(false);
      expect(goBackTo(1.5, deps)).toBe(false);
      expect(replayed).toEqual([]);
    });
  });

  describe("lazy stale-skip", () => {
    it("skips and discards a dead entry when going back", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b")); // will be reported invalid (e.g. a closed tab)
      recordNavigationHistory(entry("c"));

      const { deps, replayed } = createDeps({
        isEntryValid: (candidate) => candidate.workspaceId !== "b",
      });

      expect(goBack(deps)).toBe(true);
      expect(replayed).toEqual([entry("a")]);
      // "b" was popped and discarded, not just skipped past.
      expect(useNavigationHistoryStore.getState().backStack).toEqual([entry("a")]);
    });

    it("skips and discards a dead entry when going forward", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      goBack(createDeps().deps);
      goBack(createDeps().deps);
      // Pushed in the order they were bumped off backStack: "c" first, then "b".
      expect(useNavigationHistoryStore.getState().forwardStack).toEqual([entry("c"), entry("b")]);

      const { deps, replayed } = createDeps({
        isEntryValid: (candidate) => candidate.workspaceId !== "b",
      });
      expect(goForward(deps)).toBe(true);
      expect(replayed).toEqual([entry("c")]);
      expect(useNavigationHistoryStore.getState().forwardStack).toEqual([]);
    });

    it("returns false when every remaining back entry is invalid", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));

      const { deps, replayed } = createDeps({ isEntryValid: () => false });
      expect(goBack(deps)).toBe(false);
      expect(replayed).toEqual([]);
    });
  });

  describe("replay failure rolls back the commit", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(noop);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("goBack: a throwing replay leaves both stacks byte-identical and returns false", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      const before = useNavigationHistoryStore.getState();

      const deps: NavigationHistoryReplayDeps = {
        isEntryValid: () => true,
        replay: () => {
          throw new Error("replay failed");
        },
      };

      expect(goBack(deps)).toBe(false);
      expect(useNavigationHistoryStore.getState()).toEqual(before);
    });

    it("goBackTo: a throwing replay leaves both stacks byte-identical and returns false", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      recordNavigationHistory(entry("d"));
      const before = useNavigationHistoryStore.getState();

      const deps: NavigationHistoryReplayDeps = {
        isEntryValid: () => true,
        replay: () => {
          throw new Error("replay failed");
        },
      };

      expect(goBackTo(2, deps)).toBe(false);
      expect(useNavigationHistoryStore.getState()).toEqual(before);
    });

    it("goForward: a throwing replay leaves both stacks byte-identical and returns false", () => {
      recordNavigationHistory(entry("a"));
      recordNavigationHistory(entry("b"));
      recordNavigationHistory(entry("c"));
      goBack(createDeps().deps);
      goBack(createDeps().deps);
      const before = useNavigationHistoryStore.getState();

      const deps: NavigationHistoryReplayDeps = {
        isEntryValid: () => true,
        replay: () => {
          throw new Error("replay failed");
        },
      };

      expect(goForward(deps)).toBe(false);
      expect(useNavigationHistoryStore.getState()).toEqual(before);
    });
  });
});
