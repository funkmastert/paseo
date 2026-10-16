import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export interface WorkspaceWorkingDiffTabTarget {
  kind: "working_diff";
  focusPath?: string;
  focusRequestId?: number;
}

export type PluginWorkspaceTabTarget =
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "workspace";
    }
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "agent";
      agentId: string;
    };

/**
 * The orchestration panel, scoped by the agent the tab was opened from.
 *
 * `scopeAgentId` absent is the host-wide view. Present, it is the agent whose session opened the
 * tab — not necessarily the leader: the panel walks to the root of that agent's tree, so opening
 * from a subagent and opening from its leader land on the same tree.
 */
export interface OrchestrationWorkspaceTabTarget {
  kind: "orchestration";
  scopeAgentId?: string;
}

export type WorkspaceTabTarget =
  | { kind: "new_tab" }
  | { kind: "draft"; draftId: string; setup?: WorkspaceDraftTabSetup }
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "browser"; browserId: string }
  | { kind: "changes_tree" }
  | { kind: "files" }
  | { kind: "pull_request" }
  | OrchestrationWorkspaceTabTarget
  | WorkspaceFileTabTarget
  | WorkspaceWorkingDiffTabTarget
  | PluginWorkspaceTabTarget
  | { kind: "setup"; workspaceId: string }
  | { kind: "commit_diff"; sha: string };

export interface WorkspaceTab {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
  state?: JsonValue;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}
