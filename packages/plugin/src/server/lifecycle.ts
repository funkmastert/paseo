import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  // Categorization labels (MCP `create_agent` labels, CLI `paseo run --label`).
  // Mutable after creation; defaults to {} when none are set.
  labels: Record<string, string>;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
}

export interface PluginBeforeRequests {
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    // Read-only: the id of the agent that initiated this create, absent for
    // human-initiated creates (app/CLI top-level with no calling agent).
    callerAgentId?: string;
    // Categorization labels set by the caller (MCP `create_agent` labels, CLI
    // `paseo run --label`). Mutable by hooks. Optional on the way in — the
    // wire schema defaults it to {} — but always present by the time a hook
    // handler sees `request.labels`.
    labels?: Record<string, string>;
    // The first user message queued for delivery after creation, if any.
    initialPrompt?: string;
  };
  "agent.session_open": PluginSessionOpenRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}
