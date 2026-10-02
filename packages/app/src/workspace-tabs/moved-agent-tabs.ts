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

export function movedAgentTabStepsEqual(
  a: readonly MovedAgentTabStep[],
  b: readonly MovedAgentTabStep[],
): boolean {
  return (
    a.length === b.length &&
    a.every((step, index) => JSON.stringify(step) === JSON.stringify(b[index]))
  );
}
