import type { WorkspaceTab } from "@/workspace-tabs/model";
import { resolveShownAgent, type HeldAgentLookup } from "@/utils/agent-migration";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

interface HeldAgent {
  workspaceId?: string | null;
  labels?: Record<string, unknown> | null;
}

/**
 * What to do with a tab on a handle account failover retired. `retarget`: the tab takes the
 * successor in place. `navigate`: the successor lives in another workspace, so the app goes there.
 * `stranded`: nothing to show instead; the tab stays and the note names where it went.
 */
export type MovedAgentTabStep =
  | { kind: "retarget"; tabId: string; fromAgentId: string; toAgentId: string }
  | { kind: "navigate"; tabId: string; fromAgentId: string; toAgentId: string }
  | { kind: "stranded"; tabId: string; fromAgentId: string; movedToAgentId: string };

export function planMovedAgentTabs(input: {
  tabs: readonly WorkspaceTab[];
  workspaceId: string;
  lookup: HeldAgentLookup<HeldAgent>;
}): MovedAgentTabStep[] {
  const steps: MovedAgentTabStep[] = [];
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  for (const tab of input.tabs) {
    if (tab.target.kind !== "agent") {
      continue;
    }
    const fromAgentId = tab.target.agentId;
    const shown = resolveShownAgent(fromAgentId, input.lookup);
    if (shown.kind === "stranded") {
      steps.push({
        kind: "stranded",
        tabId: tab.tabId,
        fromAgentId,
        movedToAgentId: shown.movedToAgentId,
      });
    } else if (shown.kind === "moved") {
      const successorWorkspaceId = normalizeWorkspaceOpaqueId(
        input.lookup(shown.agentId)?.workspaceId,
      );
      steps.push({
        kind:
          successorWorkspaceId && successorWorkspaceId !== workspaceId ? "navigate" : "retarget",
        tabId: tab.tabId,
        fromAgentId,
        toAgentId: shown.agentId,
      });
    }
  }
  return steps;
}

/** One effect of following moved agents, executed in order by `useFollowMovedAgentTabs`. */
export type MovedAgentTabAction =
  | { kind: "moveDraft"; fromAgentId: string; toAgentId: string }
  | { kind: "follow"; workspaceKey: string; fromAgentId: string; toAgentId: string }
  | { kind: "closeTab"; workspaceKey: string; tabId: string }
  | { kind: "navigateToAgent"; agentId: string }
  | { kind: "announce"; agentId: string }
  | { kind: "noteStranded"; agentId: string };

/**
 * What to do about the planned steps right now. Nothing until the workspace is in view and its
 * layout has hydrated. The unsent draft travels with the conversation. The note is raised for the
 * tab in view only, and once per stranded handle (`notedStrandedAgentIds`).
 */
export function decideMovedAgentTabActions(input: {
  steps: readonly MovedAgentTabStep[];
  routeFocused: boolean;
  layoutHydrated: boolean;
  workspaceKey: string | null;
  focusedTabId: string | null;
  notedStrandedAgentIds: ReadonlySet<string>;
}): MovedAgentTabAction[] {
  const { workspaceKey } = input;
  if (!input.routeFocused || !input.layoutHydrated || !workspaceKey) {
    return [];
  }
  const actions: MovedAgentTabAction[] = [];
  for (const step of input.steps) {
    const focused = step.tabId === input.focusedTabId;
    if (step.kind === "retarget") {
      const { fromAgentId, toAgentId } = step;
      actions.push({ kind: "moveDraft", fromAgentId, toAgentId });
      actions.push({ kind: "follow", workspaceKey, fromAgentId, toAgentId });
      if (focused) {
        actions.push({ kind: "announce", agentId: toAgentId });
      }
    } else if (step.kind === "navigate") {
      // Only the tab in view leaves the workspace; a background one waits until it is chosen.
      if (focused) {
        actions.push({
          kind: "moveDraft",
          fromAgentId: step.fromAgentId,
          toAgentId: step.toAgentId,
        });
        actions.push({ kind: "closeTab", workspaceKey, tabId: step.tabId });
        actions.push({ kind: "navigateToAgent", agentId: step.toAgentId });
        actions.push({ kind: "announce", agentId: step.toAgentId });
      }
    } else if (focused && !input.notedStrandedAgentIds.has(step.fromAgentId)) {
      actions.push({ kind: "noteStranded", agentId: step.fromAgentId });
      actions.push({ kind: "announce", agentId: step.movedToAgentId });
    }
  }
  return actions;
}

export function movedAgentTabStepsEqual(
  a: readonly MovedAgentTabStep[],
  b: readonly MovedAgentTabStep[],
): boolean {
  return (
    a.length === b.length &&
    a.every((step, index) => JSON.stringify(step) === JSON.stringify(b[index]))
  );
}
