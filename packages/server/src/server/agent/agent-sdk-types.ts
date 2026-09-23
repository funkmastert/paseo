import type {
  AgentProviderNotice,
  AgentTaskItem,
  JsonValue,
  ProviderOptions,
  ToolPolicy,
} from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, McpGatewaySessionMode } from "@getpaseo/protocol/messages";
import type { PaseoToolCatalog } from "./tools/types.js";

export type { AgentProviderNotice, AgentTaskItem };

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
  isUnattended?: boolean;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  aliases?: string[];
  isSelectable?: boolean;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  contextWindowMaxTokens?: number;
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export function normalizeAgentModelDefinition(model: AgentModelDefinition): AgentModelDefinition {
  const defaultThinkingOptionId =
    model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!defaultThinkingOptionId || defaultThinkingOptionId === model.defaultThinkingOptionId) {
    return model;
  }
  return { ...model, defaultThinkingOptionId };
}

export function filterSelectableAgentModels(
  models: AgentModelDefinition[] | undefined,
): AgentModelDefinition[] {
  return models?.filter((model) => model.isSelectable !== false) ?? [];
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  source?: "builtin" | "custom";
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  iconSvg?: string;
  defaultModeId?: string | null;
  derivedFromProviderId?: string | null;
}

export interface AgentCreateConfigParent {
  provider: AgentProvider;
  modeId: string | null;
  isUnattended: boolean;
}

export interface ResolveAgentCreateConfigInput {
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  availableModes: AgentMode[] | undefined;
}

export interface ResolveAgentCreateConfigResult {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

export interface AgentCreateConfigUnattendedInput {
  modeId: string | null;
  config: AgentSessionConfig;
  features?: AgentFeature[];
  availableModes: AgentMode[];
}

export interface AgentFeatureToggle {
  type: "toggle";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: boolean;
}

export interface AgentFeatureSelect {
  type: "select";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: string | null;
  options: AgentSelectOption[];
}

export type AgentFeature = AgentFeatureToggle | AgentFeatureSelect;

export interface AgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsNativePaseoTools?: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

export interface AgentRunOptions {
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
  clientMessageId?: string;
}

export interface AgentSteerOptions extends AgentRunOptions {
  /** Deny permissions that block this steer. An accepted steer must honor this contract. */
  clearPendingPermissions?: boolean;
}

export type SteerResult = { status: "accepted" } | { status: "unavailable" };

export interface SteerActiveTurnOptions extends AgentSteerOptions {
  expectedTurnId: string;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

/** One 30s slice of a token-rate ring buffer — see token-rate-tracker.ts. */
export interface AgentTokenRateBucket {
  bucketStartMs: number;
  tokens: number;
}

/** Trailing-window burn rate, computed from the ring buffer at read time. */
export interface AgentTokenRate {
  tokensPerMinute: number;
  asOfMs: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineItem {
  type: "plugin";
  id: string;
  pluginId: string;
  kind: string;
  version: number;
  data: JsonValue;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
    }
  | CompactionTimelineItem
  | PluginTimelineItem;

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | {
      type: "turn_completed";
      provider: AgentProvider;
      usage?: AgentUsage;
      turnId?: string;
      /**
       * Provider-local per-turn cost-weighted token delta (token-rate-tracker.ts's
       * `weighTokenUsage`), feeding the burn ring. Providers that streamed `token_burn_delta`
       * events during the turn omit it here so the turn isn't counted twice; providers with no
       * burn signal omit it rather than report a fake zero. See docs/token-burn.md.
       */
      turnTokenDelta?: number;
    }
  | {
      /**
       * Cost-weighted burn for one completed API request inside a running turn, so the burn
       * ring moves while a long turn is in flight instead of receiving one lump at turn end.
       * Daemon-internal: agent-manager records it and never forwards it. See docs/token-burn.md.
       */
      type: "token_burn_delta";
      provider: AgentProvider;
      tokens: number;
    }
  | {
      /**
       * The model one API response reported for itself, once per response. Compared with the
       * configured model to catch an agent quietly served by a different one. Daemon-internal:
       * agent-manager folds it into its divergence state and never forwards it. Only the agent's
       * own frames raise it, never a subagent's, which is allowed a model of its own. See
       * docs/model-divergence.md.
       */
      type: "model_observed";
      provider: AgentProvider;
      model: string;
    }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | {
      type: "timeline";
      item: AgentTimelineItem;
      provider: AgentProvider;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    }
  | {
      type: "provider_subagent";
      provider: AgentProvider;
      event: import("./provider-subagents/store.js").ProviderSubagentInputEvent;
    }
  | {
      type: "mcp_server_statuses";
      provider: AgentProvider;
      statuses: AgentMcpServerStatus[];
    };

/**
 * A single provider-reported MCP server status from the SDK's init message (KTD8).
 * `status` is whatever string the provider reports (not a closed enum) — captured
 * verbatim, live-only, no COMPAT tag needed (a permanently-optional additive field,
 * like `lastActivitySummary`).
 */
export interface AgentMcpServerStatus {
  name: string;
  status: string;
}

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

export type AgentSlashCommandKind = "command" | "skill";

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: AgentSlashCommandKind;
}

export interface ListImportableSessionsOptions {
  limit?: number;
  /** Optional case-insensitive descriptor search text. */
  query?: string;
  /**
   * Maximum number of cheap persisted-session candidates to inspect before
   * applying the result limit. Providers must cap this at 500.
   */
  scanLimit?: number;
  /**
   * Optional cwd hint. Providers that can cheaply pre-filter importable
   * sessions by working directory should do so before doing expensive work.
   */
  cwd?: string;
}

export interface ImportableProviderSession {
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
}

export interface ImportProviderSessionInput {
  providerHandleId: string;
  cwd: string;
}

export interface ImportProviderSessionContext {
  config: AgentSessionConfig;
  storedConfig: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
}

export interface ImportedTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

export interface ImportedProviderSession {
  session: AgentSession;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle;
  timeline: ImportedTimelineEntry[];
  providerSubagentEvents?: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  cwd: string;
  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;
  /**
   * Daemon-level instructions appended at runtime. This is deliberately not
   * persisted into agent config so daemon setting changes apply cleanly.
   */
  daemonAppendSystemPrompt?: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  title?: string | null;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Runtime-only per-launch signal (KTD5/KTD6): the MCP gateway is enabled for this launch and
   * brokered entries are present in `mcpServers`. Never persisted — stripped from storage the
   * same way the brokered `mcpServers` entries are (`stripMcpGatewayServers` in
   * `runtime-mcp-config.ts`).
   */
  mcpGatewayEnabled?: boolean;
  /**
   * Runtime-only companion to `mcpGatewayEnabled`: `strict` makes the Claude adapter set
   * `strictMcpConfig` and re-inject per-dir stdio entries itself; `overlay` (the default when
   * absent) leaves the CLI's own MCP loading alone. Why overlay is the default lives in
   * docs/mcp-gateway.md "Session injection". Stripped from storage alongside `mcpGatewayEnabled`.
   */
  mcpGatewaySessionMode?: McpGatewaySessionMode;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

export interface AgentLaunchContext {
  agentId?: string;
  env?: Record<string, string>;
  /**
   * Runtime-only internal Paseo tools. This must never be persisted into
   * AgentSessionConfig; providers may adapt it to their native tool surface.
   */
  paseoTools?: PaseoToolCatalog;
}

export interface AgentCreateSessionOptions {
  /**
   * Whether the provider should leave a durable native session behind.
   * Defaults to true. Providers that cannot honor false should no-op.
   */
  persistSession?: boolean;
}

/** Runtime-only intent for a persisted-session resume. Never persist this option. */
export interface AgentResumeSessionOptions {
  /** Defaults to interactive. History loading may be read-only for archived native sessions. */
  purpose?: "interactive" | "history";
}

/**
 * Returned by respondToPermission when the permission resolution requires
 * a follow-up turn (e.g. Codex plan approval → implementation).
 */
export interface AgentPermissionResult {
  followUpPrompt?: AgentPromptInput;
}

export interface AgentSession {
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  steerActiveTurn?(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  /**
   * Resolve once every foreground turn that predates this call can no longer run or become active.
   * Calling while already idle is a successful no-op. Reject only when foreground ownership is
   * still uncertain.
   */
  interrupt(): Promise<void>;
  /** Release live runtime resources without archiving or deleting the durable native session. */
  close(): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  revertConversation?(input: { messageId: string }): Promise<void>;
  revertFiles?(input: { messageId: string }): Promise<void>;
  revertBoth?(input: { messageId: string }): Promise<void>;
  /**
   * Out-of-band prompt handler. When non-null, the manager runs the returned
   * handler instead of allocating a turn. The handler emits stream events
   * directly via the provided `emit` callback, which routes through the
   * manager's persistence + broadcast pipeline. The active foreground turn
   * (if any) is left untouched, so this is how mid-turn side-effect commands
   * (e.g. /goal pause) reach the provider without canceling the running turn.
   */
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}

export type FetchCatalogOptions =
  | {
      scope: "global";
      force: boolean;
    }
  | {
      scope: "workspace";
      cwd: string;
      force: boolean;
    };

export interface ProviderRefreshContext {
  readonly signal: AbortSignal;
  /** Track an upstream operation so timeout errors identify the work still pending. */
  runActivity<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface ProviderCatalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
  defaultModeId?: string | null;
}

export interface ResolveAgentDefaultModeInput {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Whether the account a provider's sessions run as is signed in on this host. `unknown` means the
 * provider cannot tell; nothing may infer a failure from it. `signed-in` is evidence, not proof —
 * a provider that reads a config file cannot see a revoked keychain token.
 */
export type AgentAccountAuth =
  | { state: "signed-in"; accountLabel: string | null }
  | { state: "signed-out"; signInCommand: string | null }
  | { state: "unknown" };

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  /**
   * Where this client's sessions load per-dir MCP definitions from, for the gateway's
   * "adopt a session-reported server" action (docs/mcp-gateway.md). Only providers that read
   * per-dir MCP config files implement it.
   */
  resolveMcpConfigScope?(
    cwd: string,
  ): { configDir: string; projectDir: string; env?: NodeJS.ProcessEnv } | undefined;
  /**
   * Whether this client's sessions consume the MCP gateway's brokered `mcpServers` entries
   * (docs/mcp-gateway.md "Session injection"). Asked of the client rather than read off the
   * provider id, because every account-pool provider is a derived id (`extends: "claude"`) on a
   * Claude client.
   */
  readonly acceptsMcpGatewayServers?: boolean;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;
  /** Equal keys share availability and catalogue discovery within this configured client.
   * Include the execution environment and effective configuration; omit to use target identity.
   * force must not affect identity. Resolve before every cache lookup. */
  getCatalogCacheKey?(options: FetchCatalogOptions): Promise<string | undefined>;
  /**
   * Discover models and modes together. Implementations may use one upstream
   * process, separate upstream calls, static modes, or private helpers; callers
   * outside the provider do not get separate runtime model/mode probes.
   * The registry is responsible for merging configured model overrides.
   * ProviderSnapshotManager supplies a shared context. Providers must pass its
   * signal downstream and finish resource cleanup before rejecting on abort.
   */
  fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog>;
  /** Apply provider-owned defaults to a model supplied through provider configuration. */
  resolveConfiguredModel?(model: AgentModelDefinition): AgentModelDefinition;
  resolveDefaultModeId?(input: ResolveAgentDefaultModeInput): Promise<string | undefined>;
  resolveCreateConfig?(input: ResolveAgentCreateConfigInput): ResolveAgentCreateConfigResult;
  isCreateConfigUnattended?(input: AgentCreateConfigUnattendedInput): boolean;
  listCommands?(config: AgentSessionConfig): Promise<AgentSlashCommand[]>;
  listFeatures?(config: AgentSessionConfig): Promise<AgentFeature[]>;
  listImportableSessions?(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;
  importSession?(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;
  /**
   * Whether this provider's account is signed in on this host, for explaining a failure that
   * looks like the provider's fault but is the account's. Only providers that can answer
   * cheaply and structurally implement it. See docs/mcp-gateway.md.
   */
  describeAccountAuth?(): Promise<AgentAccountAuth>;
  /**
   * Whether this client can re-open `handle`'s conversation — the transcript has to be readable
   * from this client's own account directory. Only providers that can answer implement it; an
   * absent method means "cannot tell", not "no". Used before a provider move (docs/account-failover.md).
   */
  canResumeHandle?(handle: AgentPersistenceHandle): Promise<boolean>;
  /**
   * Check availability in the catalogue target when supplied (CLI binary is installed).
   * Returns true if available, false otherwise.
   */
  isAvailable(signal?: AbortSignal, options?: FetchCatalogOptions): Promise<boolean>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  /**
   * Archive a durable native session (best-effort). Runtime release belongs to AgentSession.close().
   * Called when Paseo archives an agent so the provider's own UI reflects the same state.
   */
  archiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Unarchive a durable native session in the provider.
   * Called before Paseo clears its archived flag so provider resume can succeed.
   */
  unarchiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Release any provider-owned resources held by this client (background
   * processes, sockets, cached subprocesses, etc.). Called when the daemon
   * shuts down. Must be idempotent.
   */
  shutdown?(): Promise<void>;
}
