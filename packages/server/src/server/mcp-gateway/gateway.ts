import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError, SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  MutableMcpGatewayConfig,
  MutableMcpGatewayServerConfig,
} from "@getpaseo/protocol/messages";
import {
  buildBatchedMcpGatewayNotificationPayload,
  buildMcpGatewayNotificationPayload,
  type McpGatewayNotifiableStatus,
} from "@getpaseo/protocol/mcp-notification";

import {
  applyServerEvent,
  createDisabledServerState,
  type McpGatewayServerEvent,
  type McpGatewayServerState,
} from "./state.js";
import {
  createGatewayOAuthClientProvider,
  exchangeMcpGatewayAuthorizationCode,
  McpGatewayOAuthStateStore,
} from "./oauth.js";
import { McpGatewayTokenStore } from "./token-store.js";
import type { PushNotificationSender } from "../push/index.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  warn(...args: unknown[]): void;
}

export type McpGatewayConfig = MutableMcpGatewayConfig;
export type McpGatewayServerConfig = MutableMcpGatewayServerConfig;

export interface McpGatewaySnapshotEntry {
  readonly name: string;
  readonly status: McpGatewayServerState["status"];
  readonly critical: boolean;
  readonly lastChangedAt: number;
  readonly error?: string;
}

interface McpGatewayServerRuntime {
  config: McpGatewayServerConfig;
  state: McpGatewayServerState;
  client?: Client;
  /** Whether the current unhealthy episode (if any) already produced a push (U5). */
  notified: boolean;
}

const NOTIFICATION_BATCH_THRESHOLD = 3;

interface EvaluateTransitionNotificationInput {
  status: McpGatewayServerState["status"];
  critical: boolean;
  alreadyNotified: boolean;
}

interface EvaluateTransitionNotificationResult {
  notify: boolean;
  nextNotified: boolean;
}

/**
 * Pure per-server episode logic (R8/R11, KTD11): a critical server gets exactly one
 * notification per unhealthy episode (needs-auth or error) — repeat sweeps that land back in
 * the same unhealthy status don't re-fire. Reaching "connected" re-arms the episode so the
 * next excursion notifies again. Non-critical servers never notify (AE5). Kept pure and
 * exported so the episode/re-arm sequencing is directly testable without live network I/O —
 * `gateway.ts` has no public API to force a connected server back to unhealthy yet (that
 * lands with the mid-session failure hook in a later unit).
 */
export function evaluateTransitionNotification(
  input: EvaluateTransitionNotificationInput,
): EvaluateTransitionNotificationResult {
  if (input.status === "connected") {
    return { notify: false, nextNotified: false };
  }
  if (input.status !== "needs-auth" && input.status !== "error") {
    return { notify: false, nextNotified: input.alreadyNotified };
  }
  if (!input.critical) {
    return { notify: false, nextNotified: input.alreadyNotified };
  }
  if (input.alreadyNotified) {
    return { notify: false, nextNotified: true };
  }
  return { notify: true, nextNotified: true };
}

const AUTH_FAILURE_HTTP_CODES = new Set([401, 403]);

function isAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return error.code !== undefined && AUTH_FAILURE_HTTP_CODES.has(error.code);
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Order-sensitive: safe because `servers` is populated once at construction and never reordered. */
function sameSnapshot(
  a: readonly McpGatewaySnapshotEntry[],
  b: readonly McpGatewaySnapshotEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.name === other.name &&
      entry.status === other.status &&
      entry.critical === other.critical &&
      entry.lastChangedAt === other.lastChangedAt &&
      entry.error === other.error
    );
  });
}

type McpGatewayChangeListener = (snapshot: McpGatewaySnapshotEntry[]) => void;

function nextConnectEvent(
  status: McpGatewayServerState["status"],
): McpGatewayServerEvent | undefined {
  switch (status) {
    case "disabled":
      return { type: "enable" };
    case "error":
      return { type: "retry" };
    case "needs-auth":
      return { type: "authCompleted" };
    case "connecting":
    case "connected":
      // Already in flight or healthy — connecting again isn't a state the machine models;
      // callers that need to force a fresh attempt on a connected server should disable/
      // re-enable it explicitly instead.
      return undefined;
  }
}

/** Push-notification seam for critical-server auth loss (U5/KTD11). Tests inject a fake. */
export interface McpGatewayNotifier {
  pushNotificationSender: PushNotificationSender;
  serverId: string;
}

export interface McpGatewayOptions {
  paseoHome: string;
  config: McpGatewayConfig;
  /** The daemon's own stable reachable base URL (KTD3) — never a literal loopback. */
  oauthRedirectBaseUrl?: string;
  logger?: LoggerLike;
  /** Overridable for tests; defaults to the private 0600 file store under `paseoHome`. */
  tokenStore?: McpGatewayTokenStore;
  /** Omit to disable push notifications entirely — mirrors R10's "pay no cost" posture. */
  notifier?: McpGatewayNotifier;
}

/**
 * Daemon-side MCP client and auth authority (R1, R2). Connects upstream to
 * each configured server, owns the OAuth/static token lifecycle through the
 * 0600 token store, and tracks per-server connection state via the pure
 * state machine in `state.ts`.
 *
 * Constructs nothing when disabled (R10): an absent or `enabled: false`
 * config never touches the network and never allocates per-server runtime
 * state, so workspaces that don't use the gateway pay no cost.
 *
 * Live reconfiguration (the daemon picking up an edited `mcpGateway` config
 * section without a restart) is wired at the bootstrap layer in a later
 * unit; this service's job is owning connections for whatever config it was
 * constructed with.
 */
export class McpGateway {
  private readonly config: McpGatewayConfig;
  private readonly logger: LoggerLike | undefined;
  private readonly tokenStore: McpGatewayTokenStore;
  private readonly oauthStateStore = new McpGatewayOAuthStateStore();
  private oauthRedirectBaseUrl: string | undefined;
  private readonly servers = new Map<string, McpGatewayServerRuntime>();
  private readonly events = new EventEmitter();
  private lastEmittedSnapshot: McpGatewaySnapshotEntry[] = [];
  private notifier: McpGatewayNotifier | undefined;
  private readonly pendingNotifications: Array<{
    name: string;
    status: McpGatewayNotifiableStatus;
  }> = [];

  constructor(options: McpGatewayOptions) {
    this.config = options.config;
    this.logger = options.logger?.child({ module: "mcp-gateway" });
    this.tokenStore =
      options.tokenStore ?? new McpGatewayTokenStore(options.paseoHome, options.logger);
    this.oauthRedirectBaseUrl = options.oauthRedirectBaseUrl;
    this.notifier = options.notifier;

    if (!this.config.enabled) {
      return;
    }
    for (const [name, serverConfig] of Object.entries(this.config.servers ?? {})) {
      this.servers.set(name, {
        config: serverConfig,
        state: createDisabledServerState(),
        notified: false,
      });
    }
  }

  get enabled(): boolean {
    return this.config.enabled === true;
  }

  /** Lazy-set like `setOAuthRedirectBaseUrl`: bootstrap constructs the gateway before the
   * WebSocket server that owns the push sender exists. */
  setNotifier(notifier: McpGatewayNotifier): void {
    this.notifier = notifier;
  }

  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  getServerState(name: string): McpGatewayServerState | undefined {
    return this.servers.get(name)?.state;
  }

  getSnapshot(): McpGatewaySnapshotEntry[] {
    return Array.from(this.servers.entries()).map(([name, runtime]) => {
      const entry: {
        name: string;
        status: McpGatewayServerState["status"];
        critical: boolean;
        lastChangedAt: number;
        error?: string;
      } = {
        name,
        status: runtime.state.status,
        critical: runtime.config.critical === true,
        lastChangedAt: runtime.state.lastChangedAt,
      };
      if (runtime.state.error !== undefined) {
        entry.error = runtime.state.error;
      }
      return entry;
    });
  }

  /**
   * Subscribes to snapshot changes (U4/KTD7's `mcp_status_update` wire surface). Fires only
   * when the computed snapshot actually differs from the last one emitted — mirrors
   * `ProviderSnapshotManager`'s "change" event, which dedupes the same way before notifying.
   */
  on(event: "change", listener: McpGatewayChangeListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "change", listener: McpGatewayChangeListener): this {
    this.events.off(event, listener);
    return this;
  }

  private notifyStatusChange(): void {
    const snapshot = this.getSnapshot();
    if (sameSnapshot(this.lastEmittedSnapshot, snapshot)) return;
    this.lastEmittedSnapshot = snapshot;
    for (const listener of this.events.listeners("change")) {
      (listener as McpGatewayChangeListener)(snapshot);
    }
  }

  /** Returns the connected upstream client for a server, or undefined if it isn't connected. */
  getClient(name: string): Client | undefined {
    const runtime = this.servers.get(name);
    return runtime?.state.status === "connected" ? runtime.client : undefined;
  }

  /** Attempts to connect every configured server. No-ops entirely when disabled. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    await Promise.all(Array.from(this.servers.keys()).map((name) => this.connectServer(name)));
    await this.flushPendingNotifications();
  }

  /** Re-attempts a connection, e.g. after a re-auth completes at the daemon (R4). */
  async reconnect(name: string): Promise<void> {
    await this.connectServer(name);
    await this.flushPendingNotifications();
  }

  /** Closes every connected upstream client. Best-effort — called at daemon shutdown. */
  async stop(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.values()).map(async (runtime) => {
        try {
          await runtime.client?.close();
        } catch (error) {
          this.logger?.warn({ err: error }, "Failed to close MCP gateway upstream client");
        }
      }),
    );
  }

  /**
   * The daemon's own stable reachable base URL (KTD3), resolved once the daemon is actually
   * listening. Set lazily rather than at construction because the bound address (e.g. an
   * OS-assigned port, or a wildcard host resolved to loopback) isn't known until the HTTP
   * server starts.
   */
  setOAuthRedirectBaseUrl(baseUrl: string): void {
    this.oauthRedirectBaseUrl = baseUrl;
  }

  /**
   * Consumes a single-use OAuth `state` value (KTD3), returning the server name it was minted
   * for, or `undefined` if the state is unknown, expired, or already used. The callback route
   * (U2) calls this before doing anything else with a callback request.
   */
  consumeOAuthState(state: string): string | undefined {
    return this.oauthStateStore.consume(state);
  }

  /**
   * Completes the PKCE exchange for a callback's `code` against the server the (already
   * consumed) `state` value named. On success, tokens are persisted via the SDK's provider
   * callback and the server immediately attempts to reconnect (R4).
   */
  async completeOAuthCallback(name: string, code: string): Promise<void> {
    const runtime = this.servers.get(name);
    if (!runtime) {
      throw new Error(`Unknown MCP gateway server "${name}"`);
    }
    await exchangeMcpGatewayAuthorizationCode({
      serverUrl: runtime.config.url,
      provider: this.buildOAuthProvider(name),
      code,
    });
    await this.reconnect(name);
  }

  buildOAuthProvider(name: string): OAuthClientProvider {
    if (!this.oauthRedirectBaseUrl) {
      throw new Error(
        `MCP gateway server "${name}" needs OAuth but no reachable redirect base URL is configured`,
      );
    }
    return createGatewayOAuthClientProvider({
      serverName: name,
      tokenStore: this.tokenStore,
      stateStore: this.oauthStateStore,
      redirectUrl: `${this.oauthRedirectBaseUrl}/mcp/gateway/oauth/callback`,
    });
  }

  private buildTransport(params: {
    url: string;
    transport: McpGatewayServerConfig["transport"];
    headers?: Record<string, string>;
    authProvider?: OAuthClientProvider;
  }): Transport {
    const target = new URL(params.url);
    const requestInit = params.headers ? { headers: params.headers } : undefined;
    return params.transport === "sse"
      ? new SSEClientTransport(target, { authProvider: params.authProvider, requestInit })
      : new StreamableHTTPClientTransport(target, {
          authProvider: params.authProvider,
          requestInit,
        });
  }

  /**
   * Applies a state transition, notifies "change" subscribers (deduped in
   * notifyStatusChange), and queues a push notification for a critical server's unhealthy
   * episode (U5) — flushed by the caller's connect pass (`start()`/`reconnect()`) via
   * `flushPendingNotifications()`.
   */
  private transitionRuntime(
    name: string,
    runtime: McpGatewayServerRuntime,
    event: McpGatewayServerEvent,
  ): void {
    runtime.state = applyServerEvent(runtime.state, event);
    this.notifyStatusChange();

    const result = evaluateTransitionNotification({
      status: runtime.state.status,
      critical: runtime.config.critical === true,
      alreadyNotified: runtime.notified,
    });
    runtime.notified = result.nextNotified;
    if (result.notify && this.notifier) {
      // `notify` only ever comes back true for "needs-auth" or "error" (see
      // evaluateTransitionNotification), so this narrowing is safe.
      this.pendingNotifications.push({
        name,
        status: runtime.state.status as McpGatewayNotifiableStatus,
      });
    }
  }

  /** Sends whatever notifications a connect pass queued — one push per server, or one
   * combined push when the pass pushed more than `NOTIFICATION_BATCH_THRESHOLD` servers
   * unhealthy at once (U5). No-ops when no notifier is configured. */
  private async flushPendingNotifications(): Promise<void> {
    if (this.pendingNotifications.length === 0) return;
    const transitions = this.pendingNotifications.splice(0, this.pendingNotifications.length);
    if (!this.notifier) return;

    try {
      if (transitions.length > NOTIFICATION_BATCH_THRESHOLD) {
        await this.notifier.pushNotificationSender.send(
          buildBatchedMcpGatewayNotificationPayload({
            serverId: this.notifier.serverId,
            transitions,
          }),
        );
        return;
      }
      for (const transition of transitions) {
        await this.notifier.pushNotificationSender.send(
          buildMcpGatewayNotificationPayload({
            serverId: this.notifier.serverId,
            name: transition.name,
            status: transition.status,
          }),
        );
      }
    } catch (error) {
      this.logger?.warn({ err: error }, "Failed to send MCP gateway push notification");
    }
  }

  private async connectServer(name: string): Promise<void> {
    const runtime = this.servers.get(name);
    if (!runtime) return;

    const event = nextConnectEvent(runtime.state.status);
    if (!event) return;
    this.transitionRuntime(name, runtime, event);

    try {
      let headers: Record<string, string> | undefined;
      let authProvider: OAuthClientProvider | undefined;

      if (runtime.config.auth === "static") {
        headers = this.tokenStore.getStaticHeaders(name);
        if (!headers) {
          this.transitionRuntime(name, runtime, { type: "needsAuth" });
          return;
        }
      } else {
        // Remote OAuth-class servers are the default target class (session-settled scope).
        // Connecting without a stored token would only ever produce an UnauthorizedError, so
        // skip the network round trip and land directly in needs-auth.
        if (!this.tokenStore.getOAuthTokens(name)) {
          this.transitionRuntime(name, runtime, { type: "needsAuth" });
          return;
        }
        authProvider = this.buildOAuthProvider(name);
      }

      const transport = this.buildTransport({
        url: runtime.config.url,
        transport: runtime.config.transport,
        headers,
        authProvider,
      });
      const client = new Client({ name: "paseo-mcp-gateway", version: "1.0.0" });
      await client.connect(transport);

      runtime.client = client;
      this.transitionRuntime(name, runtime, { type: "connected" });
    } catch (error) {
      this.transitionRuntime(
        name,
        runtime,
        isAuthFailure(error)
          ? { type: "needsAuth" }
          : { type: "connectionFailed", error: errorMessage(error) },
      );
      this.logger?.warn({ err: error, server: name }, "MCP gateway server connection failed");
    }
  }
}
