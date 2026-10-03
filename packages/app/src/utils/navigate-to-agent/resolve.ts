import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import type { ShownAgentResolution } from "@/utils/agent-migration";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  pin?: boolean;
  /** Forwarded to `navigateToWorkspace` -- see its `fromHistoryReplay` doc. */
  fromHistoryReplay?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  resolveShownAgent: (input: { serverId: string; agentId: string }) => ShownAgentResolution;
  /** Raises the "Moved to <account>" note for the agent the conversation went to. */
  announceAgentMove: (input: { serverId: string; agentId: string }) => void;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  // A handle account failover retired opens its live end instead, so neither the route nor
  // navigation history ever holds the dead handle. The workspace hint belonged to the handle.
  const shown = deps.resolveShownAgent({ serverId: input.serverId, agentId: input.agentId });
  const agentId = shown.kind === "moved" ? shown.agentId : input.agentId;
  const workspaceHint = shown.kind === "moved" ? null : input.workspaceId;
  if (shown.kind !== "self") {
    deps.announceAgentMove({
      serverId: input.serverId,
      agentId: shown.kind === "moved" ? shown.agentId : shown.movedToAgentId,
    });
  }

  const agentWorkspaceId =
    workspaceHint ??
    deps.readAgentNavTarget({ serverId: input.serverId, agentId }).agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId },
    pin: input.pin,
    fromHistoryReplay: input.fromHistoryReplay,
  });
}
