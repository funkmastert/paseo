import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open, rm } from "fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService } from "../services/github-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import { UsageHistorySampler } from "./usage-history/usage-history-sampler.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import {
  createWorkspaceProvisioningService,
  type WorkspaceProvisioningService,
} from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { McpGateway, type McpGatewayConfig } from "./mcp-gateway/gateway.js";
import { installMcpGatewayRoutes } from "./mcp-gateway/routes.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import type { PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import { resolveConfigFromPersisted, type CliConfigOverrides } from "./config.js";
import { resolvePaseoToolPolicy } from "./agent/paseo-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
  type ArchiveResult,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProfile,
  AgentSkillSelection,
  FirstAgentContext,
  PluginSource,
  TerminalProfile,
} from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { loadPersistedConfig, type PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { WorkspaceTitleTracker } from "./workspace-title-tracker.js";
import { AgentTitleTracker } from "./agent-title-tracker.js";
import { AgentBudgetPacingMonitor } from "./agent-budget-pacing-monitor.js";
import { AgentLeaderCompactionMonitor } from "./agent-leader-compaction-monitor.js";
import { AgentTokenBurnMonitor } from "./agent-token-burn-monitor.js";
import { AgentModelDivergenceMonitor } from "./agent-model-divergence-monitor.js";
import { AgentResourceMonitor } from "./agent-resource-monitor.js";
import {
  ChildAdmissionController,
  loadHeldTurns,
  restoreHeldTurns,
  type ChildAdmissionConfig,
} from "./agent/child-admission.js";
import { ResumePacer, type PaceResume } from "./agent/resume-pacer.js";
import { PluginConnectionMonitor } from "./plugin-connection-monitor.js";
import { AccountFailoverMonitor } from "./agent-account-failover-monitor.js";
import { FinishObligationService } from "./agent/finish-obligation-service.js";
import type { FinishReportLadderConfig } from "./agent/finish-obligation.js";
import {
  RestartRecoveryService,
  type RestartRecoveryConfig,
} from "./agent/restart-recovery/service.js";
import {
  AgentDoneJanitor,
  askAgentWhetherDone,
  probeProjectRoot,
  readProviderHealth,
  type DoneJanitorConfig,
} from "./agent-done-janitor.js";
import { removeProjectRecord } from "./project-removal.js";
import {
  startDaemonVitals,
  type DaemonVitals,
  type DaemonVitalsConfig,
} from "./daemon-vitals/daemon-vitals.js";
import { checkWorktreeDeletionSafety } from "./done-janitor-worktree.js";
import { AgentRefocus, type RefocusConfig } from "./agent/agent-refocus.js";
import type { RemediationConfig } from "./remediation/config.js";
import {
  createForwardingRemediationSink,
  type RemediationSink,
  type WorktreeSnapshotter,
} from "./remediation/contract.js";
import { findEscalationAccountBlocker } from "./remediation/escalation.js";
import { RemediationLadder } from "./remediation/ladder.js";
import { resolveAccountPoolEntries } from "./agent/account-pool-providers.js";
import {
  AgentStallSweep,
  handOffStalledAgentToFailover,
  nudgeStalledAgent,
} from "./agent-stall-sweep.js";
import type { ProcessSampler } from "./agent/process-sampler.js";
import { summarizeArtifactJanitorRun, summarizeDoneJanitorRun } from "./disk-remedies.js";
import { sampleDirectorySizeBytes } from "../utils/directory-size-sampler.js";
import { isPaseoOwnedWorktreeCwd, resolvePaseoWorktreesBaseRoot } from "../utils/worktree.js";
import { createSystemProcessSampler } from "./agent/process-sampler.js";
import { createSaturationLedger } from "./agent/saturation-ledger.js";
import { DeviceLeaseManager, type DeviceLeaseAgentSummary } from "./agent/device-lease-manager.js";
import { TestArtifactJanitor } from "./agent/test-artifact-janitor.js";
import { createArtifactAwareLaunchGate } from "./agent/test-artifact-launch-gate.js";
import { sendPromptToAgent, formatSystemNotificationPrompt } from "./agent/agent-prompt.js";
import { WorktreeDiskMonitor } from "./worktree-disk-monitor.js";
import { resolveWorkSnapshotsConfig } from "./remediation/config.js";
import { GitWorktreeSnapshotter } from "./agent/worktree-snapshot.js";
import {
  AgentWorkSnapshotSweep,
  buildWorkSnapshotAgentViews,
  listPaseoWorktreeDirectories,
} from "./agent-work-snapshot-sweep.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { setProcessPriorityPolicy } from "../utils/process-priority.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
import { PluginService } from "./plugins/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";
import { withTimeout } from "../utils/promise-timeout.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const ADMISSION_QUEUE_FLUSH_TIMEOUT_MS = 5_000;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

// KTD3: the MCP gateway's OAuth redirect_uri must be the daemon's own stable reachable base
// URL, never a literal loopback, when reachable from elsewhere (e.g. a phone's browser). This
// loopback form is the fallback when no such public base URL is configured — the strip's auth
// action is responsible for saying so when that's the case (U7).
function createMcpGatewayLoopbackBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`;
}

function resolveMcpGatewayConfig(config: MutableDaemonConfig["mcpGateway"]): McpGatewayConfig {
  return config ?? { enabled: false };
}

/** Broken out so its branches don't add to createPaseoDaemon's/logAndResolve's own complexity. */
function applyMcpGatewayOAuthRedirectBaseUrl(
  gateway: McpGateway,
  serviceProxyPublicBaseUrl: string | null,
  boundListenTarget: ListenTarget | null,
): void {
  const baseUrl = serviceProxyPublicBaseUrl ?? createMcpGatewayLoopbackBaseUrl(boundListenTarget);
  if (baseUrl) {
    gateway.setOAuthRedirectBaseUrl(baseUrl);
  }
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  mcpGateway?: MutableDaemonConfig["mcpGateway"];
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  agentProfiles?: AgentProfile[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
    // Forwarded verbatim into the mutable config below. Both tracker sections used to be
    // dropped here, so `agents.metadataGeneration.titleTracking` in config.json only took
    // effect on a later reload, never at boot.
    titleTracking?: { enabled?: boolean; refreshIntervalMinutes?: number };
    workspaceTitleTracking?: {
      enabled?: boolean;
      refreshIntervalMinutes?: number;
      activityWindowMinutes?: number;
    };
  };
  tokenBurnMonitor?: {
    enabled?: boolean;
    ratePerMinute?: number;
    sustainedMinutes?: number;
    totalTokens?: number;
    scope?: "all" | "topLevelOnly";
    breachBatchThreshold?: number;
    usageHistory?: {
      enabled?: boolean;
    };
    modelDivergence?: {
      enabled?: boolean;
      persistResponses?: number;
      persistSeconds?: number;
    };
  };
  processPriority?: MutableDaemonConfig["processPriority"];
  resourceMonitor?: {
    enabled?: boolean;
    memoryBytesPerAgent?: number;
    cpuPercentPerAgent?: number;
    sustainedMinutes?: number;
    systemSwapUsedRatio?: number;
    orphanBuildDaemonBytes?: number;
    notifyAgent?: boolean;
    reaper?: {
      enabled?: boolean;
      dryRun?: boolean;
      idleCpuPercent?: number;
      idleMinutes?: number;
      minIdleSweeps?: number;
      maxPerSweep?: number;
      graceMs?: number;
    };
  };
  deviceLeases?: MutableDaemonConfig["deviceLeases"];
  artifactJanitor?: MutableDaemonConfig["artifactJanitor"];
  accountFailover?: {
    enabled?: boolean;
    migrateSubagents?: boolean;
    migrationConcurrency?: number;
    notifyParent?: boolean;
    collapseToSharedAccount?: boolean;
  };
  // Wire-shaped like mcpGateway above rather than restated as a literal: the monitor's own
  // settings interface would not carry the passthrough index signature this has to accept.
  budgetPacing?: MutableDaemonConfig["budgetPacing"];
  leaderCompaction?: MutableDaemonConfig["leaderCompaction"];
  /**
   * Test seams for AccountFailoverMonitor; production leaves this unset. Tests inject a fake usage
   * source (no real usage API call), push the timer past their own runtime and drive sweeps with
   * `getAccountFailoverMonitor().tick()`, and advance `now` to expire reactive evidence.
   */
  accountFailoverOverrides?: {
    providerUsage?: Pick<ProviderUsageService, "listUsage">;
    sweepIntervalMs?: number;
    now?: () => number;
    remediationSink?: RemediationSink;
    /** Stands in for restart recovery's claims, which only a real restart produces. */
    isClaimedByRestartRecovery?: (agentId: string) => boolean;
  };
  /**
   * Test seams for FinishObligationService; production leaves this unset. Tests push the timer
   * past their own runtime, drive sweeps with `getFinishObligations().tick()`, shorten the ladder
   * and advance `now`.
   */
  finishReportOverrides?: {
    sweepIntervalMs?: number;
    ladder?: Partial<FinishReportLadderConfig>;
    now?: () => number;
  };
  doneJanitor?: DoneJanitorConfig;
  admission?: ChildAdmissionConfig;
  refocus?: RefocusConfig;
  remediation?: RemediationConfig;
  daemonVitals?: DaemonVitalsConfig;
  /** Startup-only: read once at boot. See docs/restart-recovery.md. */
  restartRecovery?: RestartRecoveryConfig;
  /**
   * Test seams for AgentDoneJanitor; production leaves this unset. Tests push the timer past
   * their own runtime and drive sweeps with `getDoneJanitor().tick()`.
   */
  doneJanitorOverrides?: {
    sweepIntervalMs?: number;
    now?: () => number;
  };
  /**
   * Test seam for AgentLeaderCompactionMonitor; production leaves this unset. Tests push the
   * timer past their own runtime and drive sweeps with `getLeaderCompactionMonitor().tick()`.
   */
  leaderCompactionOverrides?: {
    sweepIntervalMs?: number;
  };
  diskSweeper?: {
    enabled?: boolean;
    sweepIntervalMs?: number;
    retentionDays?: number;
    maxDeletionsPerTick?: number;
    minFreeGB?: number;
    sampleTimeoutMs?: number;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    relayEnabledFallback: boolean;
    startupPersisted: PersistedConfig;
  };
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  mcpGateway: McpGateway;
  getMcpGatewayAuthToken(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
  /** Null until start() has constructed it (it needs the WebSocket server's push sender). */
  getAccountFailoverMonitor(): AccountFailoverMonitor | null;
  /** Null until start() has constructed it, like the account-failover monitor. */
  getDoneJanitor(): AgentDoneJanitor | null;
  /** Null until start() has constructed it, like the done janitor (docs/remediation.md). */
  getRemediationLadder(): RemediationLadder | null;
  /** The durable finish-report ledger (docs/finish-reports.md). */
  getFinishObligations(): FinishObligationService;
  /** Null until start() has constructed it, like the account-failover monitor. */
  getLeaderCompactionMonitor(): AgentLeaderCompactionMonitor | null;
  getRestartRecovery(): RestartRecoveryService;
}

export interface PaseoDaemonDependencies {
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
    relayConfig?: boolean;
  };
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(app: express.Application, config: PaseoDaemonConfig, logger: Logger): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostname(),
      logger,
    }),
  );
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function withTokenBurnMonitorConfig(
  config: Pick<PaseoDaemonConfig, "tokenBurnMonitor">,
): Pick<MutableDaemonConfig, "tokenBurnMonitor"> {
  return config.tokenBurnMonitor !== undefined ? { tokenBurnMonitor: config.tokenBurnMonitor } : {};
}

function withResourceMonitorConfig(
  config: Pick<PaseoDaemonConfig, "resourceMonitor">,
): Pick<MutableDaemonConfig, "resourceMonitor"> {
  return config.resourceMonitor !== undefined ? { resourceMonitor: config.resourceMonitor } : {};
}

function withProcessPriorityConfig(
  config: Pick<PaseoDaemonConfig, "processPriority">,
): Pick<MutableDaemonConfig, "processPriority"> {
  // Spread: an interface carries no index signature, and the wire schema is passthrough.
  return config.processPriority !== undefined
    ? { processPriority: { ...config.processPriority } }
    : {};
}

function withDeviceLeasesConfig(
  config: Pick<PaseoDaemonConfig, "deviceLeases">,
): Pick<MutableDaemonConfig, "deviceLeases"> {
  return config.deviceLeases !== undefined ? { deviceLeases: config.deviceLeases } : {};
}

function withArtifactJanitorConfig(
  config: Pick<PaseoDaemonConfig, "artifactJanitor">,
): Pick<MutableDaemonConfig, "artifactJanitor"> {
  return config.artifactJanitor !== undefined ? { artifactJanitor: config.artifactJanitor } : {};
}

function withAccountFailoverConfig(
  config: Pick<PaseoDaemonConfig, "accountFailover">,
): Pick<MutableDaemonConfig, "accountFailover"> {
  return config.accountFailover !== undefined ? { accountFailover: config.accountFailover } : {};
}

function withAdmissionConfig(
  config: Pick<PaseoDaemonConfig, "admission">,
): Pick<MutableDaemonConfig, "admission"> {
  return config.admission !== undefined ? { admission: { ...config.admission } } : {};
}

function withDoneJanitorConfig(
  config: Pick<PaseoDaemonConfig, "doneJanitor">,
): Pick<MutableDaemonConfig, "doneJanitor"> {
  // Spread: an interface carries no index signature, and the wire schema is passthrough.
  return config.doneJanitor !== undefined ? { doneJanitor: { ...config.doneJanitor } } : {};
}

function withRefocusConfig(
  config: Pick<PaseoDaemonConfig, "refocus">,
): Pick<MutableDaemonConfig, "refocus"> {
  // Spread: an interface carries no index signature, and the wire schema is passthrough.
  return config.refocus !== undefined ? { refocus: { ...config.refocus } } : {};
}

function withRemediationConfig(
  config: Pick<PaseoDaemonConfig, "remediation">,
): Pick<MutableDaemonConfig, "remediation"> {
  // Spread: an interface carries no index signature, and the wire schema is passthrough.
  return config.remediation !== undefined ? { remediation: { ...config.remediation } } : {};
}

/** One account's health right now, shared by the done janitor and the remediation ladder. */
function readProviderHealthNow(input: {
  agentManager: AgentManager;
  wsServer: Pick<VoiceAssistantWebSocketServer, "getProviderUsageService">;
  provider: string;
}): ReturnType<typeof readProviderHealth> {
  const { agentManager } = input;
  const lastErrorsByProvider = new Map<string, (string | undefined)[]>();
  for (const agent of agentManager.listAgentsForAccountFailover()) {
    const errors = lastErrorsByProvider.get(agent.provider) ?? [];
    errors.push(agent.lastError);
    lastErrorsByProvider.set(agent.provider, errors);
  }
  return readProviderHealth({
    provider: input.provider,
    isAvailable: async (id) => (await agentManager.getProviderAvailability(id)).available,
    listUsage: async () => {
      try {
        return (await input.wsServer.getProviderUsageService().listUsage()).providers;
      } catch {
        return null;
      }
    },
    lastErrorsByProvider,
  });
}

// Wired once the WebSocket server exists, like the done janitor: it needs the push sender, the
// provider-usage cache and the create path (docs/remediation.md).
function createRemediationLadder(input: {
  config: Pick<PaseoDaemonConfig, "paseoHome">;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: (
    input: Parameters<typeof createAgentCommand>[1],
  ) => ReturnType<typeof createAgentCommand>;
  wsServer: Pick<
    VoiceAssistantWebSocketServer,
    "getProviderUsageService" | "getPushNotificationSender"
  >;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  serverId: string;
  logger: Logger;
}): RemediationLadder {
  const { agentManager, agentStorage, logger } = input;
  return new RemediationLadder({
    dependencies: {
      createAgent: async (request) => {
        const result = await input.createAgent({
          kind: "mcp",
          provider: request.provider,
          title: request.title,
          initialPrompt: request.prompt,
          promptFailure: "throw",
          cwd: request.cwd,
          labels: request.labels,
          background: true,
          notifyOnFinish: false,
        });
        if (!result.initialPromptStarted) {
          throw new Error(`agent ${result.snapshot.id} was created but its prompt did not start`);
        }
        return { agentId: result.snapshot.id };
      },
      inspectAgent: async (agentId) => {
        const live = agentManager.getAgent(agentId);
        if (!live || live.lifecycle === "closed") {
          const record = await agentStorage.get(agentId);
          return record && !record.archivedAt ? { status: "unloaded" } : { status: "gone" };
        }
        if (live.lifecycle === "error") return { status: "error", error: live.lastError };
        if (live.lifecycle === "idle") {
          return {
            status: "idle",
            finalText: await agentManager.getLastAssistantMessage(agentId),
            totalTokens: live.totalTokens,
          };
        }
        return { status: "running", totalTokens: live.totalTokens };
      },
      cancelAgent: async (agentId) => {
        await agentManager.cancelAgentRun(agentId, "remediation");
      },
      archiveAgent: async (agentId) => {
        await archiveAgentCommand({ agentManager, agentStorage, logger }, agentId);
      },
      findAccountBlocker: (provider) =>
        findEscalationAccountBlocker({
          provider,
          poolEntries: resolveAccountPoolEntries(input.daemonConfigStore.get().providers),
          getHealth: (id) =>
            readProviderHealthNow({ agentManager, wsServer: input.wsServer, provider: id }),
        }),
    },
    getPushNotificationSender: () => input.wsServer.getPushNotificationSender(),
    serverId: input.serverId,
    readDaemonConfig: () => ({ remediation: input.daemonConfigStore.get().remediation }),
    statePath: path.join(input.config.paseoHome, "remediation", "state.json"),
    logger: logger.child({ module: "remediation-ladder" }),
  });
}

// Wired once the WebSocket server exists, like AccountFailoverMonitor below: it owns the push
// sender and the provider-usage cache.
function createDoneJanitor(input: {
  config: Pick<PaseoDaemonConfig, "doneJanitorOverrides" | "paseoHome" | "worktreesRoot">;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: Pick<FileBackedWorkspaceRegistry, "list">;
  projectRegistry: Pick<FileBackedProjectRegistry, "list" | "remove">;
  scheduleService: Pick<ScheduleService, "list">;
  terminalManager: TerminalManager | null;
  archiveWorkspaceById: (workspaceId: string, requestId: string) => Promise<ArchiveResult>;
  wsServer: Pick<
    VoiceAssistantWebSocketServer,
    "getProviderUsageService" | "getPushNotificationSender"
  >;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  worktreeSnapshotter: WorktreeSnapshotter;
  serverId: string;
  logger: Logger;
}): AgentDoneJanitor {
  const { agentManager, agentStorage, terminalManager, logger } = input;
  const overrides = input.config.doneJanitorOverrides;
  return new AgentDoneJanitor({
    dependencies: {
      listLiveAgents: () => agentManager.listAgentsForDoneJanitor(),
      listStoredAgents: () => agentStorage.list(),
      listWorkspaces: () => input.workspaceRegistry.list(),
      listScheduledAgentIds: async () =>
        new Set(
          (await input.scheduleService.list()).flatMap((schedule) =>
            schedule.target.type === "agent" && schedule.status !== "completed"
              ? [schedule.target.agentId]
              : [],
          ),
        ),
      getProviderHealth: (provider) =>
        readProviderHealthNow({ agentManager, wsServer: input.wsServer, provider }),
      askAgent: (ask) => askAgentWhetherDone({ agentManager, agentStorage, logger }, ask),
      archiveAgent: async (agentId) => {
        await archiveAgentCommand({ agentManager, agentStorage, logger }, agentId);
      },
      countTerminals: async (workspaceId) => {
        if (!terminalManager) return 0;
        const lists = await Promise.all(
          terminalManager
            .listDirectories()
            .map((cwd) => terminalManager.getTerminals(cwd, { workspaceId })),
        );
        return lists.flat().filter((terminal) => terminal.workspaceId === workspaceId).length;
      },
      isPaseoOwnedWorktreePath: async (worktreePath) =>
        (
          await isPaseoOwnedWorktreeCwd(worktreePath, {
            paseoHome: input.config.paseoHome,
            worktreesRoot: input.config.worktreesRoot,
          })
        ).allowed,
      checkWorktree: (check) => checkWorktreeDeletionSafety(check),
      measureBytes: (worktreePath) =>
        sampleDirectorySizeBytes(worktreePath, { timeoutMs: 120_000 }),
      reclaimWorkspace: async (workspaceId) => {
        const result = await input.archiveWorkspaceById(workspaceId, "done-janitor");
        return { removedDirectory: result.removedDirectory };
      },
      snapshotWorktree: (request) => input.worktreeSnapshotter.snapshot(request),
      listProjects: () => input.projectRegistry.list(),
      probeProjectRoot,
      removeProject: (projectId) =>
        removeProjectRecord({
          projectRegistry: input.projectRegistry,
          paseoHome: input.config.paseoHome,
          projectId,
          logger,
        }),
    },
    getPushNotificationSender: () => input.wsServer.getPushNotificationSender(),
    serverId: input.serverId,
    readDaemonConfig: () => ({ doneJanitor: input.daemonConfigStore.get().doneJanitor }),
    logger,
    sweepIntervalMs: overrides?.sweepIntervalMs,
    now: overrides?.now,
  });
}

// Wired once the WebSocket server exists, like the done janitor: account health reads its
// provider-usage cache. See docs/stalled-agents.md.
function createAgentStallSweep(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  processSampler: ProcessSampler;
  wsServer: Pick<VoiceAssistantWebSocketServer, "getProviderUsageService">;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  sink: RemediationSink;
  snapshotter: WorktreeSnapshotter;
  logger: Logger;
  paceResume: PaceResume;
}): AgentStallSweep {
  const { agentManager, agentStorage, logger } = input;
  return new AgentStallSweep({
    dependencies: {
      listAgents: () => agentManager.listAgentsForStallSweep(),
      sampleProcesses: () => input.processSampler.sampleProcesses(),
      getProviderHealth: async (provider) => {
        const lastErrorsByProvider = new Map<string, (string | undefined)[]>();
        for (const agent of agentManager.listAgentsForAccountFailover()) {
          const errors = lastErrorsByProvider.get(agent.provider) ?? [];
          errors.push(agent.lastError);
          lastErrorsByProvider.set(agent.provider, errors);
        }
        return readProviderHealth({
          provider,
          isAvailable: async (id) => (await agentManager.getProviderAvailability(id)).available,
          listUsage: async () => {
            try {
              return (await input.wsServer.getProviderUsageService().listUsage()).providers;
            } catch {
              return null;
            }
          },
          lastErrorsByProvider,
        });
      },
      snapshotter: input.snapshotter,
      nudgeAgent: (nudge) =>
        nudgeStalledAgent(
          { agentManager, agentStorage, logger, paceResume: input.paceResume },
          nudge,
        ),
      handOffToFailover: (agentId) => handOffStalledAgentToFailover(agentManager, agentId),
    },
    sink: input.sink,
    readRemediationConfig: () => input.daemonConfigStore.get().remediation,
    logger,
  });
}

function createFinishObligationService(input: {
  config: Pick<PaseoDaemonConfig, "finishReportOverrides">;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  restartRecovery: Pick<RestartRecoveryService, "isAboutToResume">;
  serverId: string;
  logger: Logger;
  paceResume: PaceResume;
  isTurnHeld: (agentId: string) => boolean;
}): FinishObligationService {
  const overrides = input.config.finishReportOverrides;
  return new FinishObligationService({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    serverId: input.serverId,
    logger: input.logger,
    isAccountFailoverEnabled: () =>
      input.daemonConfigStore.get().accountFailover?.enabled !== false,
    isClaimedByRestartRecovery: (agentId) => input.restartRecovery.isAboutToResume(agentId),
    paceResume: input.paceResume,
    isTurnHeld: input.isTurnHeld,
    sweepIntervalMs: overrides?.sweepIntervalMs,
    ladder: overrides?.ladder,
    now: overrides?.now,
  });
}

// Wired once the WebSocket server exists: it owns the push sender and the provider-usage cache.
function createAccountFailoverMonitor(input: {
  config: Pick<PaseoDaemonConfig, "accountFailoverOverrides">;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  wsServer: Pick<
    VoiceAssistantWebSocketServer,
    "getProviderUsageService" | "getPushNotificationSender"
  >;
  daemonConfigStore: Pick<DaemonConfigStore, "get">;
  remediationSink: RemediationSink;
  restartRecovery: Pick<RestartRecoveryService, "isAboutToResume">;
  serverId: string;
  logger: Logger;
  paceResume: PaceResume;
}): AccountFailoverMonitor {
  const overrides = input.config.accountFailoverOverrides;
  return new AccountFailoverMonitor({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    workspaceProvisioning: input.workspaceProvisioning,
    providerUsage: overrides?.providerUsage ?? input.wsServer.getProviderUsageService(),
    pushNotificationSender: input.wsServer.getPushNotificationSender(),
    remediationSink: overrides?.remediationSink ?? input.remediationSink,
    serverId: input.serverId,
    readDaemonConfig: () => ({
      accountFailover: input.daemonConfigStore.get().accountFailover,
      providers: input.daemonConfigStore.get().providers,
    }),
    logger: input.logger,
    isClaimedByRestartRecovery:
      overrides?.isClaimedByRestartRecovery ??
      ((agentId) => input.restartRecovery.isAboutToResume(agentId)),
    paceResume: input.paceResume,
    sweepIntervalMs: overrides?.sweepIntervalMs,
    now: overrides?.now,
  });
}

function withBudgetPacingConfig(
  config: Pick<PaseoDaemonConfig, "budgetPacing">,
): Pick<MutableDaemonConfig, "budgetPacing"> {
  return config.budgetPacing !== undefined ? { budgetPacing: config.budgetPacing } : {};
}

function withLeaderCompactionConfig(
  config: Pick<PaseoDaemonConfig, "leaderCompaction">,
): Pick<MutableDaemonConfig, "leaderCompaction"> {
  return config.leaderCompaction !== undefined ? { leaderCompaction: config.leaderCompaction } : {};
}

function withDiskSweeperConfig(
  config: Pick<PaseoDaemonConfig, "diskSweeper">,
): Pick<MutableDaemonConfig, "diskSweeper"> {
  return config.diskSweeper !== undefined ? { diskSweeper: config.diskSweeper } : {};
}

function withMcpGatewayConfig(
  config: Pick<PaseoDaemonConfig, "mcpGateway">,
): Pick<MutableDaemonConfig, "mcpGateway"> {
  return config.mcpGateway !== undefined ? { mcpGateway: config.mcpGateway } : {};
}

/** Exported for the boot pass-through test; not part of the daemon's public surface. */
export function createInitialMutableDaemonConfig(config: PaseoDaemonConfig): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: { enabled: config.relayEnabled ?? true },
    mcp: {
      enabled: config.mcpEnabled ?? true,
      injectIntoAgents: config.mcpInjectIntoAgents ?? true,
    },
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? "https://app.paseo.sh" },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: config.metadataGeneration?.providers ?? [],
    },
    ...withTokenBurnMonitorConfig(config),
    ...withResourceMonitorConfig(config),
    ...withProcessPriorityConfig(config),
    ...withDeviceLeasesConfig(config),
    ...withArtifactJanitorConfig(config),
    ...withAccountFailoverConfig(config),
    ...withBudgetPacingConfig(config),
    ...withLeaderCompactionConfig(config),
    ...withDoneJanitorConfig(config),
    ...withAdmissionConfig(config),
    ...withRefocusConfig(config),
    ...withRemediationConfig(config),
    ...withDiskSweeperConfig(config),
    ...withMcpGatewayConfig(config),
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  return initialConfig;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  const obsoleteTimelineDirectory = path.join(config.paseoHome, "agent-timelines");
  await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
    logger.warn(
      { err: error, path: obsoleteTimelineDirectory },
      "Failed to remove obsolete agent timeline data",
    );
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const initialMutableConfig = createInitialMutableDaemonConfig(config);
  const daemonConfigStore = new DaemonConfigStore(config.paseoHome, initialMutableConfig, logger, {
    relayEnabledMutable: config.relayEnabledMutable ?? true,
    startupPersisted: config.configReload?.startupPersisted,
    reloadSource: {
      resolve: (persisted) => {
        const reloaded = resolveConfigFromPersisted(config.paseoHome, persisted, {
          env: config.configReload?.env ?? process.env,
          cli: config.configReload?.cli,
          relayEnabledFallback: config.configReload?.relayEnabledFallback,
        });
        return {
          mutable: createInitialMutableDaemonConfig(reloaded),
          overrideControlledPaths: reloaded.configReload?.overrideControlledPaths ?? [],
        };
      },
    },
  });
  // Provider and git spawn sites read this at spawn time (utils/process-priority.ts). Set before
  // anything can spawn, then kept current on every patch and reload.
  setProcessPriorityPolicy(daemonConfigStore.get().processPriority);
  daemonConfigStore.onChange(() =>
    setProcessPriorityPolicy(daemonConfigStore.get().processPriority),
  );
  const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
  void orchestrationSkills.autoUpdate().catch((error) => {
    logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
  });
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});
  const pluginRuntime = new PluginService(logger, daemonConfigStore, daemonVersion, {
    managedSources: new ManagedPluginSources(config.paseoHome),
    settingsDirectory: path.join(config.paseoHome, "plugin-settings"),
  });

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayRuntime: RelayRuntime | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  // Distinct capability token authenticating sessions to the MCP gateway's brokered-server
  // proxy (/mcp/gateway/*, KTD1). Deliberately never the same value as agentMcpAuthToken above:
  // the two surfaces protect different things (the daemon's own agent-control MCP vs. brokered
  // external accounts), so leaking one must never grant the other.
  const mcpGatewayAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  daemonConfigStore.onFieldChange("trustedProxies", (value) => {
    app.set("trust proxy", value ?? ["loopback"]);
  });
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  const terminalManager = createConfiguredTerminalManager({
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const workspaceSetupRuntime = new WorkspaceSetupRuntime();
  let configuredHostnames = config.hostnames ?? config.allowedHosts;
  let appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";
  daemonConfigStore.onFieldChange("hostnames", (value) => {
    configuredHostnames = value as HostnamesConfig | undefined;
  });
  daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
    appBaseUrl = typeof value === "string" ? value : "https://app.paseo.sh";
  });
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let agentTokenBurnMonitor: AgentTokenBurnMonitor | null = null;
  let agentModelDivergenceMonitor: AgentModelDivergenceMonitor | null = null;
  let agentResourceMonitor: AgentResourceMonitor | null = null;
  let pluginConnectionMonitor: PluginConnectionMonitor | null = null;
  let accountFailoverMonitor: AccountFailoverMonitor | null = null;
  let budgetPacingMonitor: AgentBudgetPacingMonitor | null = null;
  let leaderCompactionMonitor: AgentLeaderCompactionMonitor | null = null;
  let doneJanitor: AgentDoneJanitor | null = null;
  let remediationLadder: RemediationLadder | null = null;
  let agentStallSweep: AgentStallSweep | null = null;
  let workSnapshotSweep: AgentWorkSnapshotSweep | null = null;
  let daemonVitals: DaemonVitals | null = null;
  // Assigned once projectRegistry/workspaceRegistry exist, below. Constructed ahead of wsServer
  // because Session's WorkspaceDirectory needs `getDiskUsage`/`requestDiskUsageSample` wired in
  // from the start; push notifications are resolved lazily via `getPushNotificationSender` since
  // wsServer doesn't exist yet at that point either.
  let worktreeDiskMonitor: WorktreeDiskMonitor | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const fixedAllowedOrigins = [
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ];
  const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
  daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
    allowedOrigins.clear();
    for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
      allowedOrigins.add(origin);
    }
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Serve the bundled browser web UI when enabled. Mounted after service-proxy
  // classification and host/CORS handling, but before daemon bearer auth, so
  // static app files load without the daemon password while API/WebSocket calls
  // remain protected.
  mountWebUi(app, config, logger);

  app.use(
    createRequireBearerMiddleware(config.auth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostname(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const remediationSink = createForwardingRemediationSink();
  worktreeDiskMonitor = new WorktreeDiskMonitor({
    projectRegistry,
    workspaceRegistry,
    paseoHome: config.paseoHome,
    worktreesBaseRoot: config.worktreesRoot,
    homeDir: homedir(),
    serverId,
    getPushNotificationSender: () => wsServer?.getPushNotificationSender() ?? null,
    readDaemonConfig: () => ({
      diskSweeper: daemonConfigStore.get().diskSweeper,
      remediation: daemonConfigStore.get().remediation,
    }),
    logger,
    remediationSink,
    // Lazy: the done janitor is built later than this monitor (docs/disk-pressure.md).
    getDoneJanitorRunner: () => {
      if (!doneJanitor) return null;
      const activeDoneJanitor = doneJanitor;
      return async () => {
        const raw = daemonConfigStore.get().doneJanitor;
        if (raw?.enabled !== true) {
          return summarizeDoneJanitorRun({ enabled: false, dryRun: false, report: null });
        }
        const report = await activeDoneJanitor.tick();
        return summarizeDoneJanitorRun({ enabled: true, dryRun: raw.dryRun ?? false, report });
      };
    },
    // Same laziness for the artifact janitor's on-demand sweep — it, and the process sampler it
    // needs `ps` rows from, are both built later than this monitor (both `const`s below; the
    // closure only resolves them once called, well after bootstrap finishes building them).
    getArtifactJanitorRunner: () => {
      return async () => {
        const raw = daemonConfigStore.get().artifactJanitor;
        if (raw?.enabled !== true) {
          return summarizeArtifactJanitorRun({ enabled: false, dryRun: false, result: null });
        }
        // An unreadable process table must not read as "nothing uses these simulators".
        const table = await processSampler.sampleProcessTable();
        if (table.status === "failed") {
          return {
            state: "live",
            outcome: "skipped",
            detail: "processes could not be sampled, so nothing could be proven unused",
          };
        }
        const result = await testArtifactJanitor.sweep({ rows: table.rows });
        return summarizeArtifactJanitorRun({ enabled: true, dryRun: raw.dryRun ?? false, result });
      };
    },
  });
  const workspaceLabelService = createWorkspaceLabelService({
    paseoHome: config.paseoHome,
    workspaceRegistry,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  workspaceRegistry.subscribeToMutations((mutation) => {
    if (mutation.kind === "archive" && mutation.workspace) {
      pluginRuntime.emit("workspace.archived", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  // The device cap (docs/device-leases.md). Built before the provider runtime because the
  // providers take its launch gate, and handed the agent list below once AgentManager exists —
  // it only ever reads ids, so a late binding costs nothing.
  const processSampler = createSystemProcessSampler({ logger });
  let listDeviceLeaseAgents: () => readonly DeviceLeaseAgentSummary[] = () => [];
  let sendDeviceLeaseMessageToAgent: (agentId: string, body: string) => Promise<void> = async () =>
    undefined;
  const deviceLeaseManager = new DeviceLeaseManager({
    processSampler,
    readDaemonConfig: () => ({ deviceLeases: daemonConfigStore.get().deviceLeases }),
    listAgents: () => listDeviceLeaseAgents(),
    sendSystemMessageToAgent: (agentId, body) => sendDeviceLeaseMessageToAgent(agentId, body),
    logger: logger.child({ module: "device-leases" }),
  });
  deviceLeaseManager.reportMode();

  // The artifact janitor (docs/artifact-janitor.md). Built next to the cap and wrapped around
  // its launch gate, so one PreToolUse hook serves both: the janitor refuses a launch onto a
  // full volume and notes a test run's cleanup obligation, then the cap decides about slots.
  const testArtifactJanitor = new TestArtifactJanitor({
    homeDir: homedir(),
    readDaemonConfig: () => ({ artifactJanitor: daemonConfigStore.get().artifactJanitor }),
    listAgentIds: () => listDeviceLeaseAgents().map((agent) => agent.agentId),
    listLeasedDeviceIds: () => deviceLeaseManager.listLeasedDeviceIds(),
    logger: logger.child({ module: "artifact-janitor" }),
  });
  // Work snapshots (docs/work-snapshots.md): the done janitor, the work-at-risk sweep and the
  // stalled-agent sweep all snapshot through this one instance.
  const worktreeSnapshotter = new GitWorktreeSnapshotter({
    readConfig: () => resolveWorkSnapshotsConfig(daemonConfigStore.get().remediation),
    paseoHome: config.paseoHome,
    logger: logger.child({ module: "work-snapshots" }),
  });
  const deviceLaunchGate = createArtifactAwareLaunchGate({
    janitor: testArtifactJanitor,
    inner: deviceLeaseManager,
    logger: logger.child({ module: "artifact-janitor" }),
  });

  const agentProviderRuntime = await createAgentProviderRuntime({
    paseoHome: config.paseoHome,
    logger,
    snapshotManager: {
      refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      deviceLaunchGate,
      isDev: config.isDev === true,
      extraClients: config.agentClients,
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  daemonConfigStore.onFieldChange("catalogRefreshTimeoutMs", (value) => {
    providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
  });
  daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  daemonConfigStore.onFieldChange("git.maxProcessConcurrency", () => {
    const git = daemonConfigStore.get().git;
    if (git) configureGitProcessPolicy(git);
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  // The title tracker needs the AgentManager instance it's scheduling
  // refreshes against, but AgentManager needs a callback at construction
  // time. Break the cycle with a reassignable closure; pointed at the real
  // tracker once it's constructed below.
  let handleAgentTurnFinished: (params: { agentId: string; cwd: string }) => void = () => {};
  const agentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    onAgentTurnFinished: (params) => handleAgentTurnFinished(params),
    mcpAuthToken: agentMcpAuthToken,
    resolvePaseoToolPolicy: (provider) =>
      resolvePaseoToolPolicy(provider, daemonConfigStore.get().providers),
    logger,
  });
  // Same reassignable-closure trick as handleAgentTurnFinished above: the device cap was built
  // before AgentManager because the providers need its gate, and it only reads the agent list.
  listDeviceLeaseAgents = () =>
    agentManager.listAgentsForResourceMonitor().map((agent) => ({
      agentId: agent.id,
      provider: agent.provider,
      isRunning: agent.isRunning,
    }));
  // The cap's only lever over a provider it cannot refuse: tell the agent about a device it
  // took without asking. Same steer path the resource monitor uses (agent-prompt.ts).
  sendDeviceLeaseMessageToAgent = async (agentId, body) => {
    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId,
      prompt: formatSystemNotificationPrompt(body),
      activeTurnBehavior: "steer",
      unarchive: false,
      logger,
    });
  };
  // The status surface clients subscribe to (`device_status_update`), reachable from Session
  // through the AgentManager it already holds.
  agentManager.setDeviceLeaseStatusSource({
    getSnapshot: () => deviceLeaseManager.getSnapshot(),
    subscribe: (listener) => deviceLeaseManager.subscribe(listener),
  });
  const syncPluginProviders = () => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  };
  const unsubscribePluginProviders =
    pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  // Before any agent can start a turn: the cap on concurrent child turns, and the pacer every
  // bulk resume path shares (docs/resource-monitor.md, "Child admission and resume pacing").
  const admissionQueuePath = path.join(config.paseoHome, "admission", "queue.json");
  const heldTurnsAtBoot = await loadHeldTurns(admissionQueuePath, logger);
  const childAdmission = new ChildAdmissionController({
    readConfig: () => daemonConfigStore.get().admission,
    listAgents: () => agentManager.listAgentsForAdmission(),
    logger,
    queueFilePath: admissionQueuePath,
  });
  childAdmission.adoptRestored(heldTurnsAtBoot);
  agentManager.setChildAdmission(childAdmission);
  // A raised cap or a disable applies to the children already waiting, not only to new ones.
  daemonConfigStore.onChange(() => childAdmission.pump());
  const resumePacer = new ResumePacer({
    readSettings: () => {
      const settings = childAdmission.settings();
      return { enabled: settings.enabled, perMinute: settings.bulkResumesPerMinute };
    },
    logger,
  });

  // Before anything can load or prompt an agent: the open run markers are the only record of who
  // was mid-turn when the last daemon stopped, and the first new turn would replace them.
  const restartRecovery = await RestartRecoveryService.capture({
    agentStorage,
    agentManager,
    config: config.restartRecovery,
    logger: logger.child({ module: "restart-recovery" }),
    isTurnHeld: (agentId) => childAdmission.holdsTurnFor(agentId),
    paceResume: (resume, fn) => resumePacer.run(resume, fn),
  });
  // Before anything can arm or load an agent: the ledger rebuilds every owed finish report from
  // the records, so a restart still knows who is waiting to hear back. Recovery decides who was
  // mid-turn and resumes them; the ledger leaves alone any agent recovery has claimed.
  const finishObligations = createFinishObligationService({
    config,
    agentManager,
    agentStorage,
    daemonConfigStore,
    restartRecovery,
    serverId,
    logger,
    paceResume: (resume, fn) => resumePacer.run(resume, fn),
    isTurnHeld: (agentId) => childAdmission.holdsTurnFor(agentId),
  });
  await finishObligations.initialize();
  agentManager.setFinishObligations(finishObligations);
  await bootstrapWorkspaceRegistries({
    serverId,
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  await workspaceLabelService.initialize();
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
  });
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
  ) => {
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
    });
    if (!existingWorkspace || existingWorkspace.archivedAt) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      { titleSource: "auto" },
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  const agentTitleTracker = new AgentTitleTracker({
    agentManager,
    agentStorage,
    providerSnapshotManager,
    workspaceGitService,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    logger,
  });
  handleAgentTurnFinished = (params) => agentTitleTracker.scheduleRefresh(params);
  agentTitleTracker.start();

  const workspaceTitleTracker = new WorkspaceTitleTracker({
    agentManager,
    workspaceRegistry,
    providerSnapshotManager,
    workspaceGitService,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });
  workspaceTitleTracker.start();

  // Refocus (docs/refocus.md). Needs nothing but the manager and live config, so it is watching
  // before the first prompt can be dispatched.
  const agentRefocus = new AgentRefocus({
    agentManager,
    readDaemonConfig: () => ({ refocus: daemonConfigStore.get().refocus }),
    logger: logger.child({ module: "refocus" }),
  });
  agentManager.setPromptDispatchInterceptor((agentId, prompt) =>
    agentRefocus.interceptPrompt(agentId, prompt),
  );
  agentRefocus.start();
  daemonConfigStore.onChange(() => agentRefocus.reportMode());

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createPaseoWorktreeForTools = async (
    input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
  ) => {
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        createPaseoWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredPaseoWorktree(workflowInput, {
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        startWorkspaceSetup: (workspaceId, operation) =>
          workspaceSetupRuntime.start(workspaceId, operation),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createPaseoWorktree: createPaseoWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const archiveWorkspaceByIdExternal = (workspaceId: string, requestId: string) =>
    archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceIdToKill),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      { scope: { kind: "workspace", workspaceId }, requestId },
    );
  const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    agentManager,
    agentStorage,
    github,
    workspaceGitService,
    createPaseoWorktreeWorkflow: createPaseoWorktreeForTools,
    archiveAgentForClose: (agentId) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emit: emitExternalSessionMessage,
    emitAgentRemove: async () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    killTerminalsForWorkspace: (workspaceId) =>
      killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
    logger,
  });
  const hubRelationships = new HubRelationshipController({
    paseoHome: config.paseoHome,
    hostname: getHostname(),
    serverId,
    daemonPublicKey: daemonKeyPair.publicKeyB64,
    logger,
    remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
    clock: dependencies.hubRelationshipClock,
    retryPolicy: dependencies.hubRelationshipRetryPolicy,
    createDaemonId: dependencies.createHubDaemonId,
    attachSocket: async (socket, options) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      await wsServer.attachExternalSocket(
        socket,
        { transport: "hub", hubDaemonId: options.daemonId },
        {
          principalId: options.principalId,
          permissions: options.permissions,
          hubExecutionAgents: options.agents,
        },
        options.sessionProtocol === "legacy"
          ? {
              type: "hello",
              clientId: `hub:${options.daemonId}`,
              clientType: "hub",
              protocolVersion: 1,
            }
          : undefined,
      );
    },
    updateAttachedPermissions: (principalId, permissions) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      wsServer.updatePrincipalPermissions(principalId, permissions);
    },
    createExecutionAgents: (daemonId) =>
      new DaemonExecutions({
        daemonId,
        agentManager,
        agentStorage,
        createAgent,
        interruptAgent: (agentId) => cancelAgentRunCommand({ agentManager, logger }, agentId),
        archiveWorkspace: archiveWorkspaceByIdExternal,
        cleanupFailedCreate: (input) =>
          hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
      }),
  });

  const createScheduleLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      resolveFirstAgentPromptTitle(input.firstAgentContext),
      undefined,
      { titleSource: "auto" },
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createSchedulePaseoWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createPaseoWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
    await archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "schedule-run-finish",
      },
    );
  };
  const scheduleService = new ScheduleService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
    createPaseoWorktreeWorkspace: createSchedulePaseoWorktreeExternal,
    archiveWorkspace: archiveScheduleWorkspaceExternal,
  });
  await scheduleService.start();
  agentManager.startProviderSubagentSweep();
  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.completeForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const createAgentToolHostDependencies = (
    runtime: PaseoToolRuntimeContext,
  ): PaseoToolHostDependencies => ({
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    projectRegistry,
    createDirectoryWorkspace: async (cwd, title, projectId) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        // The caller named it deliberately; the tracker leaves it alone.
        title ? { titleSource: "manual" } : undefined,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceGitService,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      // MCP operations do not belong to one WebSocket session, so lifecycle
      // status updates fan out to every connected client.
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      spawnWorkspaceScript,
      assertAutomationAllowed: (workspaceId) =>
        assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
      globalServicePorts: loadPersistedConfig(config.paseoHome).worktrees?.servicePorts,
    }),
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    deviceLeaseManager,
    paseoToolPolicy:
      runtime.paseoToolPolicy ??
      (runtime.callerAgentId ? agentManager.getPaseoToolPolicy(runtime.callerAgentId) : undefined),
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
    createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setPaseoToolCatalog(enabled ? createAgentToolCatalog({}) : null);
  };
  agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
  agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  // MCP gateway (U1/U2): daemon-side client + auth authority for brokered external MCP
  // servers, and the /mcp/gateway/* routes agent sessions relay through. Constructed with
  // whatever `mcpGateway` config the daemon started with — live reconfiguration is out of
  // scope here (see McpGateway's class doc) — and started (fire-and-forget, below, after
  // wsServer is accepting connections) once the daemon's own reachable base URL is known
  // (needed for the OAuth redirect_uri, KTD3). Non-blocking so an unreachable upstream
  // never delays the daemon that manages all agents from coming up.
  const mcpGateway = new McpGateway({
    paseoHome: config.paseoHome,
    config: resolveMcpGatewayConfig(daemonConfigStore.get().mcpGateway),
    logger,
  });
  installMcpGatewayRoutes(app, {
    gateway: mcpGateway,
    capabilityToken: mcpGatewayAuthToken,
    password: config.auth?.password,
    mcpDebug: config.mcpDebug,
    logger,
  });
  // U3: wires the gateway + its distinct capability token into session injection
  // (`prepareSessionConfig`'s `withRuntimeMcpGatewayServers`). Deferred to a setter rather than
  // a constructor option because the gateway is built after the agent manager.
  agentManager.setMcpGateway(mcpGateway, mcpGatewayAuthToken);
  // Servers adopted at runtime (docs/mcp-gateway.md) survive a restart by landing in
  // config.json through the same patch path the app's config editor uses; the live gateway
  // already holds them, so the store's "restart required" note for mcpGateway is moot here.
  mcpGateway.setServerPersister((name, serverConfig) => {
    daemonConfigStore.patch({ mcpGateway: { servers: { [name]: serverConfig } } });
  });

  let mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({
          callerAgentId,
          paseoToolPolicy: callerAgentId
            ? agentManager.getPaseoToolPolicy(callerAgentId)
            : undefined,
        }),
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!mcpEnabled) {
        res.status(404).json({ error: "Agent MCP endpoint disabled" });
        return;
      }
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
            body: describeMcpDebugPayload(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            // KTD3: prefer the daemon's configured public base URL (the service-proxy
            // precedent) over the loopback fallback, so a reachable-from-elsewhere daemon
            // gets a redirect_uri a remote browser can actually complete OAuth against.
            applyMcpGatewayOAuthRedirectBaseUrl(
              mcpGateway,
              serviceProxyPublicBaseUrl,
              boundListenTarget,
            );
            const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
            agentMcpBaseUrl =
              !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            // U3: the same loopback-normalized base the /mcp/agents entry uses (agent
            // subprocesses run on this machine, same as the daemon) — distinct from the
            // OAuth redirect base URL (KTD3), which prefers a publicly reachable address.
            agentManager.setMcpGatewayBaseUrl(createMcpGatewayLoopbackBaseUrl(boundListenTarget));
            agentManager.setPaseoToolsEnabled(mcpEnabled && config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
              mcpEnabled = value !== false;
              const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
              agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && inject);
              setAgentProviderToolsEnabled(mcpEnabled && inject);
            });
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(mcpEnabled && value !== false);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                getAllowedOrigins: () => allowedOrigins,
                getHostnames: () => configuredHostnames,
                daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                startPaused: true,
              },
              workspaceAutoName,
              config.auth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                get appBaseUrl() {
                  return appBaseUrl;
                },
                desktopManaged: config.desktopManaged === true,
                getRelayConfig: () =>
                  relayRuntime?.getConfig() ?? {
                    enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                    endpoint: relayEndpoint,
                    publicEndpoint: relayPublicEndpoint,
                    useTls: relayUseTls,
                    publicUseTls: relayPublicUseTls,
                  },
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              hubRelationships,
              workspaceSetupRuntime,
              pluginRuntime,
              orchestrationSkills,
              workspaceLabelService,
              worktreeDiskMonitor
                ? {
                    get: (workspaceId) => worktreeDiskMonitor!.getDiskUsage(workspaceId),
                    requestSample: (workspaceId, cwd) =>
                      worktreeDiskMonitor!.requestSample(workspaceId, cwd),
                  }
                : undefined,
              restartRecovery,
            );
            pluginRuntime.bindPaseoSessionHost(wsServer);
            await pluginRuntime.start();
            wsServer.beginAcceptingConnections();
            worktreeDiskMonitor?.start();
            // Fire-and-forget, like worktreeDiskMonitor above: an unreachable upstream
            // must not delay the daemon that manages all agents from accepting
            // connections. Errors surface per-server via getServerState()/mcp_status_update
            // rather than here.
            void mcpGateway.start().catch((error: unknown) => {
              logger.warn({ err: error }, "MCP gateway failed to start one or more servers");
            });
            // Wired here (rather than at construction, above) for the same reason as the
            // token-burn monitor below: the push sender doesn't exist until wsServer does.
            mcpGateway.setNotifier({
              pushNotificationSender: wsServer.getPushNotificationSender(),
              serverId,
            });
            // Wired here (rather than beside AgentTitleTracker, above) because it needs the
            // push sender wsServer resolved (injected override, or its own
            // createPushNotifications) — not available until wsServer exists.
            // Captured before the closure: `wsServer` is a mutable binding at this scope, so
            // reaching through it from inside readProviderUsage loses its non-null narrowing.
            const providerUsageService = wsServer.getProviderUsageService();
            agentTokenBurnMonitor = new AgentTokenBurnMonitor({
              agentManager,
              agentStorage,
              pushNotificationSender: wsServer.getPushNotificationSender(),
              remediationSink,
              serverId,
              // Same steer path AgentResourceMonitor uses below, for the same reason: it is
              // the only way to put a system-authored message into a live turn.
              sendSystemMessageToAgent: async (agentId, body) => {
                await sendPromptToAgent({
                  agentManager,
                  agentStorage,
                  agentId,
                  prompt: formatSystemNotificationPrompt(body),
                  activeTurnBehavior: "steer",
                  unarchive: false,
                  logger,
                });
              },
              readProviderUsage: async () => (await providerUsageService.listUsage()).providers,
              // The sampler shares the monitor's 60s loop and the usage service's cache; the
              // store is the one the sessions read, so a request sees what was just recorded.
              usageHistory: new UsageHistorySampler({
                store: wsServer.getUsageHistoryStore(),
                readProviderUsage: async () => (await providerUsageService.listUsage()).providers,
                readSettings: () => daemonConfigStore.get().tokenBurnMonitor?.usageHistory,
                logger,
              }),
              // So the governor's downgrade never sets a model the agent's provider does not
              // have. `downgradeToModel` is one string for a fleet that is not one provider.
              listProviderModels: async (provider) =>
                (await providerSnapshotManager.listModels({ provider })).map((model) => model.id),
              readDaemonConfig: () => ({
                tokenBurnMonitor: daemonConfigStore.get().tokenBurnMonitor,
                providers: daemonConfigStore.get().providers,
              }),
              logger,
            });
            agentTokenBurnMonitor.start();
            // Same push sender as the token-burn monitor above. Reads its settings from the same
            // config block but is switched on by its own flag, off unless set.
            agentModelDivergenceMonitor = new AgentModelDivergenceMonitor({
              agentManager,
              pushNotificationSender: wsServer.getPushNotificationSender(),
              serverId,
              readSettings: () => daemonConfigStore.get().tokenBurnMonitor?.modelDivergence,
              logger,
            });
            agentModelDivergenceMonitor.start();
            // Wired here for the same reason as the token-burn monitor above — needs the push
            // sender wsServer resolved. sendSystemMessageToAgent reuses the same steer path
            // chat mentions and notify-on-finish use (agent-prompt.ts's sendPromptToAgent).
            agentResourceMonitor = new AgentResourceMonitor({
              agentManager,
              agentStorage,
              pushNotificationSender: wsServer.getPushNotificationSender(),
              remediationSink,
              serverId,
              processSampler,
              saturationLedger: createSaturationLedger({ paseoHome: config.paseoHome, logger }),
              // The cap counts devices from this same sweep sample rather than taking its own
              // `ps` — one scan a minute on a machine that is already struggling.
              reportDeviceSample: (sample) => deviceLeaseManager.reconcileFromSample(sample),
              // Same deal for the artifact janitor: it needs the sweep's `ps` rows to prove
              // nothing still references a simulator directory before it deletes one.
              sweepTestArtifacts: (input) => testArtifactJanitor.sweep(input),
              // The saturation rung holds new child turns until load falls; running turns and
              // root agents are untouched (docs/resource-monitor.md).
              holdChildAdmission: (held, reason) =>
                childAdmission.setHold("cpu-saturation", held, reason),
              sendSystemMessageToAgent: async (agentId, body) => {
                await sendPromptToAgent({
                  agentManager,
                  agentStorage,
                  agentId,
                  prompt: formatSystemNotificationPrompt(body),
                  activeTurnBehavior: "steer",
                  unarchive: false,
                  logger,
                });
              },
              readDaemonConfig: () => ({
                resourceMonitor: daemonConfigStore.get().resourceMonitor,
              }),
              logger,
            });
            agentResourceMonitor.start();
            // A reload or a config patch logs each monitor's new mode now rather than at its next
            // sweep, a minute later — the moment someone is most likely to be checking.
            const tokenBurnMonitorForModeLog = agentTokenBurnMonitor;
            const resourceMonitorForModeLog = agentResourceMonitor;
            const modelDivergenceMonitorForModeLog = agentModelDivergenceMonitor;
            daemonConfigStore.onChange(() => {
              tokenBurnMonitorForModeLog.reportMode();
              modelDivergenceMonitorForModeLog.reportMode();
              resourceMonitorForModeLog.reportMode();
              deviceLeaseManager.reportMode();
            });
            pluginConnectionMonitor = new PluginConnectionMonitor({
              listConnectivity: () => pluginRuntime.listSessionConnectivity(),
              pushNotificationSender: wsServer.getPushNotificationSender(),
              serverId,
              logger,
            });
            pluginConnectionMonitor.start();
            accountFailoverMonitor = createAccountFailoverMonitor({
              config,
              agentManager,
              agentStorage,
              workspaceProvisioning,
              wsServer,
              daemonConfigStore,
              remediationSink,
              restartRecovery,
              serverId,
              logger,
              paceResume: (resume, fn) => resumePacer.run(resume, fn),
            });
            accountFailoverMonitor.start();
            finishObligations.start({
              pushNotificationSender: wsServer.getPushNotificationSender(),
            });
            // Fire-and-forget: the pacer spreads these over minutes, and each goes through
            // admission again. Steer, so a child someone already prompted is never cancelled.
            void restoreHeldTurns({
              controller: childAdmission,
              pacer: resumePacer,
              held: heldTurnsAtBoot,
              dispatch: async (turn) => {
                await sendPromptToAgent({
                  agentManager,
                  agentStorage,
                  agentId: turn.agentId,
                  prompt: turn.prompt,
                  ...(turn.runOptions ? { runOptions: turn.runOptions } : {}),
                  activeTurnBehavior: "steer",
                  unarchive: false,
                  // If it queues again, it keeps its place in line rather than joining the back.
                  queuedAt: turn.queuedAt,
                  logger,
                });
              },
              logger,
            });
            // Advice-only sibling of the two monitors above: it reads the same cached usage rows
            // the failover monitor does and the same steer path, and never acts on either.
            budgetPacingMonitor = new AgentBudgetPacingMonitor({
              agentManager,
              providerUsage: providerUsageService,
              sendSystemMessageToAgent: async (agentId, body) => {
                await sendPromptToAgent({
                  agentManager,
                  agentStorage,
                  agentId,
                  prompt: formatSystemNotificationPrompt(body),
                  activeTurnBehavior: "steer",
                  unarchive: false,
                  logger,
                });
              },
              readDaemonConfig: () => ({
                budgetPacing: daemonConfigStore.get().budgetPacing,
                providers: daemonConfigStore.get().providers,
              }),
              logger,
            });
            budgetPacingMonitor.start();
            // Starts its own turns rather than steering, through startTurnIfIdle, so it takes no
            // sendSystemMessageToAgent: every message it sends waits for an idle agent.
            leaderCompactionMonitor = new AgentLeaderCompactionMonitor({
              agentManager,
              pushNotificationSender: wsServer.getPushNotificationSender(),
              serverId,
              readDaemonConfig: () => ({
                leaderCompaction: daemonConfigStore.get().leaderCompaction,
              }),
              logger,
              sweepIntervalMs: config.leaderCompactionOverrides?.sweepIntervalMs,
            });
            leaderCompactionMonitor.start();
            const leaderCompactionMonitorForModeLog = leaderCompactionMonitor;
            daemonConfigStore.onChange(() => leaderCompactionMonitorForModeLog.reportMode());
            doneJanitor = createDoneJanitor({
              config,
              agentManager,
              agentStorage,
              workspaceRegistry,
              projectRegistry,
              scheduleService,
              terminalManager,
              archiveWorkspaceById: archiveWorkspaceByIdExternal,
              wsServer,
              daemonConfigStore,
              worktreeSnapshotter,
              serverId,
              logger,
            });
            doneJanitor.start();
            remediationLadder = createRemediationLadder({
              config,
              agentManager,
              agentStorage,
              createAgent,
              wsServer,
              daemonConfigStore,
              serverId,
              logger,
            });
            remediationSink.attach(remediationLadder);
            // Fire-and-forget: reconciling in-flight agents reads agent state and must not delay
            // the daemon from accepting connections.
            void remediationLadder.start().catch((error: unknown) => {
              logger.error({ err: error }, "Remediation ladder failed to start");
            });
            const stallSweep = createAgentStallSweep({
              agentManager,
              agentStorage,
              processSampler,
              wsServer,
              daemonConfigStore,
              sink: remediationSink,
              snapshotter: worktreeSnapshotter,
              logger,
              paceResume: (resume, fn) => resumePacer.run(resume, fn),
            });
            agentStallSweep = stallSweep;
            stallSweep.start();
            daemonConfigStore.onChange(() => stallSweep.reportMode());
            workSnapshotSweep = new AgentWorkSnapshotSweep({
              dependencies: {
                listAgents: async () =>
                  buildWorkSnapshotAgentViews({
                    live: agentManager.listAgentsForDoneJanitor(),
                    stored: await agentStorage.list(),
                    lastErrors: new Map(
                      agentManager
                        .listAgentsForAccountFailover()
                        .map((agent) => [agent.id, agent.lastError]),
                    ),
                  }),
                listActiveWorkspaceDirectories: async () =>
                  (await workspaceRegistry.list())
                    .filter((workspace) => !workspace.archivedAt)
                    .map((workspace) => workspace.worktreeRoot ?? workspace.cwd),
                listOrphanCandidates: async () =>
                  listPaseoWorktreeDirectories(
                    resolvePaseoWorktreesBaseRoot({
                      paseoHome: config.paseoHome,
                      worktreesRoot: config.worktreesRoot,
                    }),
                  ),
                snapshotter: worktreeSnapshotter,
              },
              sink: remediationSink,
              readConfig: () => daemonConfigStore.get().remediation,
              statePath: path.join(config.paseoHome, "work-snapshots.json"),
              logger: logger.child({ module: "work-snapshots" }),
            });
            workSnapshotSweep.start();
            daemonVitals = startDaemonVitals({
              config: config.daemonVitals,
              paseoHome: config.paseoHome,
              serverId,
              pushNotificationSender: wsServer.getPushNotificationSender(),
              logger,
            });
            restartRecovery.start();
            relayRuntime = createRelayRuntime({
              config: {
                enabled: relayEnabled,
                endpoint: relayEndpoint,
                publicEndpoint: relayPublicEndpoint,
                useTls: relayUseTls,
                publicUseTls: relayPublicUseTls,
              },
              logger,
              attachSocket: async (ws, metadata) => {
                if (!wsServer) throw new Error("WebSocket server is not ready");
                await wsServer.attachExternalSocket(ws, metadata);
              },
              serverId,
              daemonKeyPair: daemonKeyPair.keyPair,
            });
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              relayRuntime?.setEnabled(value === true);
            });
            await hubRelationships.start();
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      unsubscribePluginProviders();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async () => {
    await pluginRuntime.stopAllPlugins();
    unsubscribePluginProviders();
    await hubRelationships.stop();
    workspaceReconciliation.dispose();
    scriptHealthMonitor.stop();
    restartRecovery.stop();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    agentManager.prepareForShutdown();
    resumePacer.stop();
    // Before the closures below: each one would otherwise read as its child's outcome.
    finishObligations.prepareForShutdown();
    await closeAllAgents(logger, agentManager);
    await agentManager.flushForShutdown().catch(() => undefined);
    // Held child prompts must be on disk before exit; bounded, so a stuck disk can't hang it.
    await withTimeout(
      childAdmission.flush(),
      ADMISSION_QUEUE_FLUSH_TIMEOUT_MS,
      "Timed out saving held child turns",
    ).catch((error: unknown) => {
      logger.warn({ err: error }, "Held child turns may be missing from the admission queue");
    });
    await finishObligations.stop().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await agentProviderRuntime.shutdown();
    terminalManager.killAll();
    await speechService.stop();
    agentManager.stopProviderSubagentSweep();
    agentTitleTracker.stop();
    workspaceTitleTracker.stop();
    agentManager.setPromptDispatchInterceptor(null);
    agentRefocus.stop();
    agentTokenBurnMonitor?.stop();
    // After the monitor stops: its last sweep's readings are still in memory, not on disk.
    await wsServer?.getUsageHistoryStore().close();
    agentModelDivergenceMonitor?.stop();
    agentResourceMonitor?.stop();
    deviceLeaseManager.stop();
    pluginConnectionMonitor?.stop();
    accountFailoverMonitor?.stop();
    budgetPacingMonitor?.stop();
    leaderCompactionMonitor?.stop();
    doneJanitor?.stop();
    remediationLadder?.stop();
    agentStallSweep?.stop();
    workSnapshotSweep?.stop();
    worktreeDiskMonitor?.stop();
    await mcpGateway.stop().catch(() => undefined);
    await scheduleService.stop().catch(() => undefined);
    await relayRuntime?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Last, so a wedge during any earlier step is still observed and the heartbeat file only says
    // "stopped" once everything else has.
    await daemonVitals?.stop();
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    // The gateway instance and its distinct capability token (KTD1) — the accessor session
    // injection (U3) will need to build brokered `mcpServers` entries.
    mcpGateway,
    getMcpGatewayAuthToken: () => mcpGatewayAuthToken,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
    getAccountFailoverMonitor: () => accountFailoverMonitor,
    getDoneJanitor: () => doneJanitor,
    getRemediationLadder: () => remediationLadder,
    getFinishObligations: () => finishObligations,
    getLeaderCompactionMonitor: () => leaderCompactionMonitor,
    getRestartRecovery: () => restartRecovery,
  };
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}
