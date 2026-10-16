import { create } from "zustand";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * One remembered "screen": a workspace plus optionally the tab it named.
 * Mirrors `NavigateToWorkspaceInput`'s `{serverId, workspaceId, target}` shape
 * so a replay is a direct call into `navigateToWorkspace` -- no separate
 * screen taxonomy to keep in sync. Pane geometry, scroll position, and
 * sidebar state are deliberately excluded: workspace-layout-store already
 * remembers those per-workspace, and duplicating them here would go stale on
 * rearrange.
 */
export interface NavHistoryEntry {
  serverId: string;
  workspaceId: string;
  target?: WorkspaceTabTarget;
}

/** Session-only: no `persist`. See navigation-history-store's design notes. */
interface NavigationHistoryState {
  backStack: NavHistoryEntry[];
  forwardStack: NavHistoryEntry[];
}

export interface NavigationHistoryReplayDeps {
  /** True when the entry still resolves against current session/layout state. */
  isEntryValid: (entry: NavHistoryEntry) => boolean;
  /** Performs the actual navigation. Must pass `fromHistoryReplay: true` so the
   * choke point that calls `recordNavigationHistory` doesn't re-record it. */
  replay: (entry: NavHistoryEntry) => void;
}

export const NAVIGATION_HISTORY_MAX_ENTRIES = 50;

export const useNavigationHistoryStore = create<NavigationHistoryState>(() => ({
  backStack: [],
  forwardStack: [],
}));

/** Exported for the recent-history menu's de-dup pass -- see history-recent-menu-model.ts. */
export function entriesEqual(a: NavHistoryEntry, b: NavHistoryEntry): boolean {
  if (a.serverId !== b.serverId || a.workspaceId !== b.workspaceId) {
    return false;
  }
  if (!a.target && !b.target) {
    return true;
  }
  if (!a.target || !b.target) {
    return false;
  }
  return workspaceTabTargetsEqual(a.target, b.target);
}

function pushCapped(stack: readonly NavHistoryEntry[], entry: NavHistoryEntry): NavHistoryEntry[] {
  const next = [...stack, entry];
  return next.length > NAVIGATION_HISTORY_MAX_ENTRIES
    ? next.slice(next.length - NAVIGATION_HISTORY_MAX_ENTRIES)
    : next;
}

/**
 * Records a navigation as the new current location. Called from the
 * `navigateToWorkspace`/`navigateToAgent` choke point for every real
 * (non-replay) navigation: pushes onto the back-stack and clears the
 * forward-stack, browser-style. Consecutive duplicates (same triple as the
 * current top) are dropped rather than pushed.
 */
export function recordNavigationHistory(entry: NavHistoryEntry): void {
  useNavigationHistoryStore.setState((state) => {
    const current = state.backStack.at(-1);
    if (current && entriesEqual(current, entry)) {
      return state;
    }
    return {
      backStack: pushCapped(state.backStack, entry),
      forwardStack: [],
    };
  });
}

/**
 * The `navigateToWorkspace` choke point calls this unconditionally with every
 * navigation, real or replayed. Isolated from the `fromHistoryReplay` check so
 * it's unit-testable without the choke point's AsyncStorage/expo-router deps
 * -- see navigation-history-store.test.ts's "replay does not re-record" case.
 */
export function recordNavigationHistoryUnlessReplay(
  input: NavHistoryEntry & { fromHistoryReplay?: boolean },
): void {
  if (input.fromHistoryReplay) {
    return;
  }
  recordNavigationHistory({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: input.target,
  });
}

/** Removes every entry belonging to one workspace, e.g. once it's archived. */
export function pruneWorkspace(workspaceKey: string): void {
  const belongsToWorkspace = (entry: NavHistoryEntry) =>
    buildWorkspaceTabPersistenceKey(entry) === workspaceKey;
  useNavigationHistoryStore.setState((state) => ({
    backStack: state.backStack.filter((entry) => !belongsToWorkspace(entry)),
    forwardStack: state.forwardStack.filter((entry) => !belongsToWorkspace(entry)),
  }));
}

/** `backStack`'s last entry is the current location, so going back needs at least one more below it. */
export function canGoBack(state: NavigationHistoryState): boolean {
  return state.backStack.length > 1;
}

export function canGoForward(state: NavigationHistoryState): boolean {
  return state.forwardStack.length > 0;
}

/**
 * Walks back through history, skipping (and discarding) entries that no
 * longer resolve -- a closed tab, an archived workspace -- and replays the
 * first valid one found. Returns false with no state change when nothing
 * valid remains behind the current entry.
 */
export function goBack(deps: NavigationHistoryReplayDeps): boolean {
  const { backStack: previousBackStack, forwardStack: previousForwardStack } =
    useNavigationHistoryStore.getState();
  let target: NavHistoryEntry | null = null;
  useNavigationHistoryStore.setState((state) => {
    if (state.backStack.length === 0) {
      return state;
    }
    const backStack = [...state.backStack];
    const current = backStack.pop();
    if (current === undefined) {
      return state;
    }
    while (backStack.length > 0) {
      const candidate = backStack.at(-1);
      if (candidate && deps.isEntryValid(candidate)) {
        target = candidate;
        break;
      }
      backStack.pop();
    }
    if (!target) {
      // Nothing valid behind the current entry -- leave state untouched.
      return state;
    }
    return { backStack, forwardStack: pushCapped(state.forwardStack, current) };
  });
  if (!target) {
    return false;
  }
  try {
    deps.replay(target);
  } catch (error) {
    // The stacks already committed above, ahead of the replay. If replay throws, the
    // navigation never actually happened, so roll the commit back rather than leaving the
    // stacks pointing somewhere the app never went.
    useNavigationHistoryStore.setState({
      backStack: previousBackStack,
      forwardStack: previousForwardStack,
    });
    console.error("[navigation-history] goBack replay failed; history left unchanged", error);
    return false;
  }
  return true;
}

/**
 * Jumps directly to the entry `depth` steps behind the current location -- what calling `goBack`
 * `depth` times in a row would land on, with every entry passed over (the current one, plus each
 * intermediate stop) moved onto the forward stack in the same order those calls would produce.
 * Stale entries along the way are discarded exactly as `goBack` discards them, and don't count
 * toward `depth` -- only entries `deps.isEntryValid` accepts do.
 *
 * Used by the recent-history menu, where an item's position already encodes its depth (see
 * `history-recent-menu-model.ts`'s `selectRecentHistoryEntries`). A single state update and a
 * single replay, rather than `depth` separate ones, so the app doesn't visibly navigate through
 * every entry in between on the way to the one the user picked.
 *
 * If there aren't `depth` valid entries behind the current one, this stops at the last one it
 * could reach (still moving what it passed over to the forward stack) rather than failing
 * outright -- the same "run out of history" outcome `goBack` reaches one call at a time.
 */
export function goBackTo(depth: number, deps: NavigationHistoryReplayDeps): boolean {
  if (!Number.isInteger(depth) || depth < 1) {
    return false;
  }
  const { backStack: previousBackStack, forwardStack: previousForwardStack } =
    useNavigationHistoryStore.getState();
  let target: NavHistoryEntry | null = null;
  useNavigationHistoryStore.setState((state) => {
    const backStack = [...state.backStack];
    let forwardStack = state.forwardStack;
    let hopsCompleted = 0;
    while (hopsCompleted < depth) {
      const current = backStack.pop();
      if (current === undefined) {
        break;
      }
      let hopTarget: NavHistoryEntry | null = null;
      while (backStack.length > 0) {
        const candidate = backStack.at(-1);
        if (candidate && deps.isEntryValid(candidate)) {
          hopTarget = candidate;
          break;
        }
        backStack.pop();
      }
      if (!hopTarget) {
        // Nothing valid left behind `current` -- put it back and stop short of `depth`.
        backStack.push(current);
        break;
      }
      forwardStack = pushCapped(forwardStack, current);
      hopsCompleted += 1;
    }
    if (hopsCompleted === 0) {
      return state;
    }
    target = backStack.at(-1) ?? null;
    return { backStack, forwardStack };
  });
  if (!target) {
    return false;
  }
  try {
    deps.replay(target);
  } catch (error) {
    // Same rationale as goBack: replay failed, so undo the hop(s) already committed above.
    useNavigationHistoryStore.setState({
      backStack: previousBackStack,
      forwardStack: previousForwardStack,
    });
    console.error("[navigation-history] goBackTo replay failed; history left unchanged", error);
    return false;
  }
  return true;
}

/**
 * Mirrors `goBack`: walks forward, skipping and discarding invalid entries,
 * and replays the first valid one found.
 */
export function goForward(deps: NavigationHistoryReplayDeps): boolean {
  const { backStack: previousBackStack, forwardStack: previousForwardStack } =
    useNavigationHistoryStore.getState();
  let target: NavHistoryEntry | null = null;
  useNavigationHistoryStore.setState((state) => {
    const forwardStack = [...state.forwardStack];
    let backStack = state.backStack;
    while (forwardStack.length > 0) {
      const candidate = forwardStack.pop();
      if (!candidate) {
        continue;
      }
      if (deps.isEntryValid(candidate)) {
        target = candidate;
        backStack = pushCapped(state.backStack, candidate);
        break;
      }
      // Stale forward entry: drop it and keep looking further forward.
    }
    return { backStack, forwardStack };
  });
  if (!target) {
    return false;
  }
  try {
    deps.replay(target);
  } catch (error) {
    // Same rationale as goBack: replay failed, so undo the commit above.
    useNavigationHistoryStore.setState({
      backStack: previousBackStack,
      forwardStack: previousForwardStack,
    });
    console.error("[navigation-history] goForward replay failed; history left unchanged", error);
    return false;
  }
  return true;
}
