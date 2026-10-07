import type { Agent } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export type AskJevPinnedWorkspace = Pick<
  SidebarWorkspacePlacement,
  "serverId" | "workspaceId" | "name"
>;

export type AskJevAgentCandidate = Pick<
  Agent,
  "id" | "serverId" | "workspaceId" | "archivedAt" | "title"
>;

export interface AskJevAgentOption {
  id: string;
  label: string;
}

/** The pinned chats on the selected host, same ones the sidebar's Pinned section lists. */
export function selectPinnedWorkspacesForServer(
  pinnedChats: readonly AskJevPinnedWorkspace[],
  serverId: string | null,
): AskJevPinnedWorkspace[] {
  if (!serverId) return [];
  return pinnedChats.filter((workspace) => workspace.serverId === serverId);
}

function workspaceKey(serverId: string, workspaceId: string | null): string | null {
  const normalized = normalizeWorkspaceOpaqueId(workspaceId);
  return normalized ? `${serverId}:${normalized}` : null;
}

/**
 * One option per live (non-archived) agent in a pinned workspace. A workspace with a single
 * agent is labelled by its chat name alone, matching the sidebar; one with several is labelled
 * "chat name — agent title" so they can be told apart.
 */
export function buildPinnedAgentOptions(input: {
  pinnedWorkspaces: readonly AskJevPinnedWorkspace[];
  agents: readonly AskJevAgentCandidate[];
}): AskJevAgentOption[] {
  const { pinnedWorkspaces, agents } = input;
  const options: AskJevAgentOption[] = [];
  for (const workspace of pinnedWorkspaces) {
    const key = workspaceKey(workspace.serverId, workspace.workspaceId);
    if (!key) continue;
    const workspaceAgents = agents.filter(
      (agent) =>
        !agent.archivedAt && workspaceKey(agent.serverId, agent.workspaceId ?? null) === key,
    );
    const labelWithAgentTitle = workspaceAgents.length > 1;
    for (const agent of workspaceAgents) {
      options.push({
        id: agent.id,
        label: labelWithAgentTitle
          ? `${workspace.name} — ${agent.title?.trim() || "Untitled agent"}`
          : workspace.name,
      });
    }
  }
  return options;
}

/**
 * Pinned workspaces with no live agent in the already-loaded set. The default aggregated-agents
 * fetch excludes agents whose workspace or project was archived by housekeeping — the done
 * janitor archives idle workspaces without unpinning or archiving the agents in them (see
 * docs/done-janitor.md) — so a pinned chat's agent can be missing even though the chat is not.
 * The caller uses this to trigger a one-off unscoped refresh that closes the gap.
 */
export function findPinnedWorkspacesMissingAgents(input: {
  pinnedWorkspaces: readonly AskJevPinnedWorkspace[];
  agents: readonly AskJevAgentCandidate[];
}): string[] {
  const { pinnedWorkspaces, agents } = input;
  const covered = new Set<string>();
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    const key = workspaceKey(agent.serverId, agent.workspaceId ?? null);
    if (key) covered.add(key);
  }
  const missing: string[] = [];
  for (const workspace of pinnedWorkspaces) {
    const key = workspaceKey(workspace.serverId, workspace.workspaceId);
    if (key && !covered.has(key)) missing.push(workspace.workspaceId);
  }
  return missing;
}
