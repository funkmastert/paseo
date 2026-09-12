import { entriesEqual, type NavHistoryEntry } from "@/stores/navigation-history-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * How many distinct entries the recent-history menu shows -- see
 * docs/plans/2026-09-12-001-feat-global-back-history-plan.md's "long-press / right-click" surface.
 */
export const HISTORY_RECENT_MENU_MAX_ENTRIES = 8;

/** One row the recent-history menu can show, before label resolution. */
export interface HistoryRecentMenuCandidate {
  entry: NavHistoryEntry;
  /**
   * Number of `goBack` calls needed to reach this entry from the current location -- pass
   * straight to `goBackTo` when the row is selected.
   */
  depth: number;
}

/**
 * Walks the back-stack from just below the current location (its top entry) downward, and
 * returns up to `maxEntries` distinct entries, most recent first.
 *
 * `depth` counts only entries `isEntryValid` accepts, in the order encountered -- the same rule
 * `goBack`/`goBackTo` apply when they silently skip and discard stale entries, so a row's `depth`
 * always lands `goBackTo` on that exact row. A closed tab or archived workspace is dropped from
 * consideration entirely: it never counts toward depth and never appears in the list.
 *
 * "Distinct" is first-occurrence-wins: if the same location appears again further back, the
 * closer occurrence is kept and the farther one is skipped, though it still consumes a depth
 * value for anything beyond it.
 */
export function selectRecentHistoryEntries(
  backStack: readonly NavHistoryEntry[],
  isEntryValid: (entry: NavHistoryEntry) => boolean,
  maxEntries: number = HISTORY_RECENT_MENU_MAX_ENTRIES,
): HistoryRecentMenuCandidate[] {
  const results: HistoryRecentMenuCandidate[] = [];
  let depth = 0;
  // backStack[length - 1] is the current location; start just below it.
  for (let i = backStack.length - 2; i >= 0 && results.length < maxEntries; i -= 1) {
    const candidate = backStack[i];
    if (!candidate || !isEntryValid(candidate)) {
      continue;
    }
    depth += 1;
    if (results.some((existing) => entriesEqual(existing.entry, candidate))) {
      continue;
    }
    results.push({ entry: candidate, depth });
  }
  return results;
}

/** Fallback tab-kind labels, mirroring the tab strip's own `fallbackTabLabels` (loading state). */
export interface HistoryRecentTabLabels {
  newTab: string;
  newAgent: string;
  setup: string;
  terminal: string;
  browser: string;
  agent: string;
  changes: string;
  files: string;
  pullRequest: string;
  orchestration: string;
}

function resolveTabLabel(
  target: WorkspaceTabTarget,
  labels: HistoryRecentTabLabels,
  agentTitle: string | null,
): string {
  switch (target.kind) {
    case "new_tab":
      return labels.newTab;
    case "draft":
      return labels.newAgent;
    case "setup":
      return labels.setup;
    case "terminal":
      return labels.terminal;
    case "browser":
      return labels.browser;
    case "file":
      return target.path.split("/").findLast(Boolean) ?? target.path;
    case "working_diff":
    case "changes_tree":
      return labels.changes;
    case "files":
      return labels.files;
    case "pull_request":
      return labels.pullRequest;
    case "commit_diff":
      return target.sha.slice(0, 7);
    case "orchestration":
      return labels.orchestration;
    case "agent":
      return agentTitle ?? labels.agent;
    default:
      return labels.agent;
  }
}

export interface HistoryRecentEntryLabel {
  /** The tab's own label, or the workspace's display name when the entry names no specific tab. */
  primary: string;
  /** The workspace's display name, shown as a subtitle when `primary` is a tab label. */
  secondary?: string;
}

/**
 * Resolves what a recent-history row should read. Pure: every piece of live state (workspace
 * name, agent title) is looked up by the caller and passed in, so this has no store or i18n
 * dependency of its own -- see `use-history-recent-menu-entries.ts` for the wiring.
 */
export function resolveHistoryRecentEntryLabel(input: {
  entry: NavHistoryEntry;
  workspaceDisplayName: string | null;
  agentTitle: string | null;
  labels: HistoryRecentTabLabels;
}): HistoryRecentEntryLabel {
  const workspaceName = input.workspaceDisplayName ?? input.entry.workspaceId;
  if (!input.entry.target) {
    return { primary: workspaceName };
  }
  return {
    primary: resolveTabLabel(input.entry.target, input.labels, input.agentTitle),
    secondary: workspaceName,
  };
}
