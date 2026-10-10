import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY, type SidebarLabelFilter } from "@/stores/sidebar-view-store";
import type { StatusBucket, StatusGroup } from "@/hooks/sidebar-status-view-model";

export interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  leading: { kind: "status"; bucket: StatusBucket } | { kind: "agent"; needsAttention: boolean };
}

export function statusWorkspaceGroups(groups: readonly StatusGroup[]): SidebarWorkspaceGroup[] {
  return groups.map((group) => ({
    key: group.bucket,
    label: group.label,
    rows: group.rows,
    leading: { kind: "status", bucket: group.bucket },
  }));
}

/** The statuses that mean an agent in the group is waiting on Tyler: a permission or an error. */
const AGENT_GROUP_ATTENTION_BUCKETS: ReadonlySet<StatusBucket> = new Set(["needs_input", "failed"]);

export const AGENT_WORKSPACES_GROUP_KEY = "agent-workspaces";

/**
 * The one collapsed "Agent workspaces (N)" section for every workspace an agent made
 * (R3, docs/done-janitor.md#manual-pin-vs-auto-pin). Returns null when there are none, so a
 * caller can skip it rather than render an empty, permanently-collapsible section.
 */
export function agentWorkspacesGroup(
  rows: readonly SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup | null {
  if (rows.length === 0) return null;
  const needsAttention = rows.some((row) => AGENT_GROUP_ATTENTION_BUCKETS.has(row.statusBucket));
  return {
    key: AGENT_WORKSPACES_GROUP_KEY,
    label: `Agent workspaces (${rows.length})`,
    rows: [...rows],
    leading: { kind: "agent", needsAttention },
  };
}

/**
 * Whether `group`'s header should render collapsed, from the one persisted
 * `collapsedWorkspaceGroupKeys` set every workspace group shares.
 *
 * Every ordinary group (status) defaults open: the set holds the keys a person collapsed by
 * hand, so absence means expanded. The agent-workspaces group defaults the other way — closed
 * until a person opens it — so for it alone the set holds an explicit *expand*, and absence
 * means collapsed. `toggleWorkspaceGroupCollapsed(group.key)` still just flips membership either
 * way, so the store and its persistence stay the single mechanism for both.
 */
export function isSidebarWorkspaceGroupCollapsed(
  group: SidebarWorkspaceGroup,
  collapsedWorkspaceGroupKeys: ReadonlySet<string>,
): boolean {
  const inSet = collapsedWorkspaceGroupKeys.has(group.key);
  return group.leading.kind === "agent" ? !inSet : inSet;
}

/**
 * Applies the Labels page's selection to the sidebar.
 *
 * `Unlabelled` is a row like any other, so it is a key in the same list rather than a boolean
 * beside it; the only thing that makes it special is what the key asks of a workspace.
 * Selecting several labels includes workspaces carrying any of them.
 */
export function filterWorkspacesByLabels(
  input: { workspaces: readonly SidebarWorkspaceEntry[] } & SidebarLabelFilter,
): SidebarWorkspaceEntry[] {
  const { workspaces, labels } = input;
  if (labels.length === 0) return [...workspaces];
  return workspaces.filter((workspace) => {
    // Whitespace-only names normalize away, so `size === 0` is exactly "carries no real label"
    // and the empty key can only ever mean Unlabelled.
    const keys = new Set((workspace.labels ?? []).map(workspaceLabelKey).filter(Boolean));
    const matches = (key: string) =>
      key === SIDEBAR_UNLABELLED_LABEL_KEY ? keys.size === 0 : keys.has(key);
    return labels.some(matches);
  });
}
