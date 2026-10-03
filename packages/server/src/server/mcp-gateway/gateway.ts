import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError, SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  McpGatewaySessionMode,
  MutableMcpGatewayConfig,
  MutableMcpGatewayLocalServerConfig,
  MutableMcpGatewayServerConfig,
} from "@getpaseo/protocol/messages";
import {
  buildBatchedMcpGatewayNotificationPayload,
  buildMcpGatewayNotificationPayload,
  type McpGatewayNotifiableStatus,
} from "@getpaseo/protocol/mcp-notification";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";

import {
  applyServerEvent,
  createDisabledServerState,
  type McpGatewayServerEvent,
  type McpGatewayServerState,
} from "./state.js";
import {
  ClientRegistrationRefusedError,
  createGatewayOAuthClientProvider,
  describeOAuthFailure,
  exchangeMcpGatewayAuthorizationCode,
  McpGatewayOAuthStateStore,
  MissingOAuthClientError,
  registrationExcludesScope,
  resolveOfflineAccessScope,
  startMcpGatewayAuthorization,
  type StartMcpGatewayAuthResult,
} from "./oauth.js";
import { McpGatewayTokenStore } from "./token-store.js";
import { McpGatewayActionError } from "./action-failure.js";
import type { PushNotificationSender } from "../push/index.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  warn(...args: unknown[]): void;
}

export type McpGatewayConfig = MutableMcpGatewayConfig;
export type McpGatewayServerConfig = MutableMcpGatewayServerConfig;
export type McpGatewayLocalServerConfig = MutableMcpGatewayLocalServerConfig;

function isLocalServerConfig(
  config: McpGatewayServerConfig | McpGatewayLocalServerConfig,
): config is McpGatewayLocalServerConfig {
  return "command" in config;
}

/** First retry delay after a local server exits on its own; doubles per exit up to the cap. */
const LOCAL_SERVER_RESTART_BASE_MS = 2_000;
const LOCAL_SERVER_RESTART_MAX_MS = 5 * 60_000;
/** A local server up at least this long before exiting has its backoff reset. */
const LOCAL_SERVER_STABLE_UPTIME_MS = 60_000;
/** How much of a local server's stderr is kept for the log line when it fails to start. */
const LOCAL_SERVER_STDERR_TAIL_CHARS = 2_000;

/** Stored env values shorter than this are flags like `1` or `off`, not credentials; replacing
 * them would mangle every digit in the log line. */
const MIN_REDACTED_VALUE_LENGTH = 8;

/** Replaces every stored env value in a local server's own output. Such a server is third-party
 * code holding a credential, and nothing stops it echoing its environment into an error. */
function redactValues(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of values) {
    if (value.length >= MIN_REDACTED_VALUE_LENGTH) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  return redacted;
}

export interface McpGatewaySnapshotEntry {
  readonly name: string;
  readonly status: McpGatewayServerState["status"];
  readonly critical: boolean;
  readonly lastChangedAt: number;
  readonly error?: string;
}

interface McpGatewayServerRuntime {
  config: McpGatewayServerConfig | McpGatewayLocalServerConfig;
  state: McpGatewayServerState;
  client?: Client;
  /** Whether the current unhealthy episode (if any) already produced a push (U5). */
  notified: boolean;
  /** Local servers only: consecutive unexpected exits, for restart backoff. */
  restarts?: number;
  connectedAt?: number;
  restartTimer?: NodeJS.Timeout;
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
 * exported so the episode/re-arm sequencing is directly testable without live network I/O.
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
  // What a token refresh throws when the upstream will not refresh: the refresh token was
  // revoked or expired, or the client it was issued to is gone. Either way only sign-in helps.
  if (
    error instanceof InvalidGrantError ||
    error instanceof InvalidTokenError ||
    error instanceof InvalidClientError ||
    error instanceof UnauthorizedClientError
  ) {
    return true;
  }
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return error.code !== undefined && AUTH_FAILURE_HTTP_CODES.has(error.code);
  }
  return false;
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

/**
 * Thrown by `requestUpstream` when a server has no live upstream to send to — never connected,
 * or its login just died under a request. The proxy route turns it into its needs-auth error.
 */
export class McpGatewayUpstreamUnavailableError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP gateway server "${serverName}" needs authentication`);
    this.name = "McpGatewayUpstreamUnavailableError";
  }
}

/** Push-notification seam for critical-server auth loss (U5/KTD11). Tests inject a fake. */
export interface McpGatewayNotifier {
  pushNotificationSender: PushNotificationSender;
  serverId: string;
}

/**
 * Maps whatever the OAuth start threw onto a reason. `MissingOAuthClientError` is the one that
 * is not a failure at all — sign-in never began, because the operator has not supplied a client
 * yet — so it carries the two host facts that let a client tell them what to do.
 */
function toStartAuthorizationFailure(name: string, error: unknown): McpGatewayActionError {
  if (error instanceof McpGatewayActionError) {
    return error;
  }
  if (error instanceof MissingOAuthClientError) {
    return new McpGatewayActionError("client_not_registered", error.message, {
      redirectUrl: error.redirectUrl,
      path: error.credentialsPath,
    });
  }
  if (error instanceof ClientRegistrationRefusedError) {
    // No remedy fields: there is nothing on this host to change.
    return new McpGatewayActionError("client_registration_refused", error.message);
  }
  const described = describeOAuthFailure(name, error);
  return new McpGatewayActionError(described.reason, described.message);
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
  /** Persists a server adopted at runtime (`adoptServer`) so the next boot has it too. */
  persistServer?: McpGatewayServerPersister;
}

export type McpGatewayServerPersister = (
  name: string,
  config: McpGatewayServerConfig,
) => void | Promise<void>;

export interface AdoptMcpGatewayServerInput {
  name: string;
  url: string;
  transport: McpGatewayServerConfig["transport"];
  headers?: Record<string, string>;
}

export interface AdoptMcpGatewayServerResult {
  status: McpGatewayServerState["status"];
  auth: "oauth" | "static";
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
  private persistServer: McpGatewayServerPersister | undefined;
  private stopped = false;
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
    this.persistServer = options.persistServer;

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
    for (const [name, serverConfig] of Object.entries(this.config.localServers ?? {})) {
      // Sessions reach every brokered server by name, so one name cannot mean two servers.
      if (this.servers.has(name)) {
        this.logger?.warn(
          { server: name },
          "MCP gateway local server shares a name with a remote server; ignoring the local one",
        );
        continue;
      }
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

  /** How brokered entries meet the CLI's own MCP loading (docs/mcp-gateway.md "Session injection"). */
  get sessionMode(): McpGatewaySessionMode {
    return this.config.sessionMode ?? "overlay";
  }

  /** Lazy-set like `setOAuthRedirectBaseUrl`: bootstrap constructs the gateway before the
   * WebSocket server that owns the push sender exists. */
  setNotifier(notifier: McpGatewayNotifier): void {
    this.notifier = notifier;
  }

  /** Lazy-set like `setNotifier`: the config store's patch path is wired after construction. */
  setServerPersister(persistServer: McpGatewayServerPersister): void {
    this.persistServer = persistServer;
  }

  /**
   * Brokers a server discovered in an agent session's own per-dir config (docs/mcp-gateway.md,
   * "Adopting a session-reported server"). An `Authorization` header in the definition makes it
   * static-auth with the full header set stored privately; any other headers ride along as
   * extraHeaders on an OAuth record. Idempotent on name: an already-brokered server is left
   * exactly as it is. The runtime entry is live immediately — later session launches inject it
   * and the strip shows it — and `persistServer` writes it to config for the next boot.
   */
  async adoptServer(input: AdoptMcpGatewayServerInput): Promise<AdoptMcpGatewayServerResult> {
    if (!this.enabled) {
      throw new Error("MCP gateway is disabled");
    }
    const existing = this.servers.get(input.name);
    if (existing) {
      return {
        status: existing.state.status,
        auth: existing.config.auth === "static" ? "static" : "oauth",
      };
    }
    const headers = input.headers ?? {};
    const hasAuthorizationHeader = Object.keys(headers).some(
      (key) => key.toLowerCase() === "authorization",
    );
    const auth: "oauth" | "static" = hasAuthorizationHeader ? "static" : "oauth";
    const config: McpGatewayServerConfig = {
      url: input.url,
      transport: input.transport,
      critical: false,
      auth,
    };
    if (auth === "static") {
      this.tokenStore.saveStaticHeaders(input.name, headers);
    } else if (Object.keys(headers).length > 0) {
      this.tokenStore.saveOAuthExtraHeaders(input.name, headers);
    }
    this.servers.set(input.name, {
      config,
      state: createDisabledServerState(),
      notified: false,
    });
    try {
      await this.persistServer?.(input.name, config);
    } catch (error) {
      this.logger?.warn(
        { err: error, server: input.name },
        "Failed to persist adopted MCP gateway server",
      );
    }
    this.notifyStatusChange();
    await this.connectServer(input.name);
    await this.flushPendingNotifications();
    return { status: this.servers.get(input.name)?.state.status ?? "disabled", auth };
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
    // Order-sensitive compare is safe: `servers` is populated once at construction and
    // never reordered, and getSnapshot() omits `error` rather than setting it undefined.
    if (isDeepStrictEqual(this.lastEmittedSnapshot, snapshot)) return;
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

  /**
   * Sends one proxied request to a server's live upstream. The SDK transport refreshes an
   * expired access token on the 401 by itself and persists the result through the token store,
   * so a refreshable login never surfaces here. What does surface is a login that cannot be
   * renewed — an access token with no refresh token, or a refresh the upstream refused — and
   * the connect-time state never sees that, so this is where the server moves to needs-auth and
   * a critical one pushes, instead of reading "connected" while every call fails.
   */
  async requestUpstream<T>(name: string, request: (client: Client) => Promise<T>): Promise<T> {
    const runtime = this.servers.get(name);
    const client = runtime?.state.status === "connected" ? runtime.client : undefined;
    if (!runtime || !client) {
      throw new McpGatewayUpstreamUnavailableError(name);
    }
    try {
      return await request(client);
    } catch (error) {
      // A request still in flight on a client an earlier failure already retired fails with
      // "connection closed"; the cause is the same lost login.
      const retired = runtime.client !== client;
      if (!retired && !isAuthFailure(error)) {
        throw error;
      }
      // Concurrent requests fail together; only the first one still holding the live client
      // moves the state, so the episode notifies once.
      if (!retired && runtime.state.status === "connected") {
        runtime.client = undefined;
        this.transitionRuntime(name, runtime, { type: "refreshFailed" });
        this.logger?.warn({ err: error, server: name }, "MCP gateway upstream login expired");
        void client.close().catch(() => undefined);
        await this.flushPendingNotifications();
      }
      throw new McpGatewayUpstreamUnavailableError(name);
    }
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
    this.stopped = true;
    await Promise.all(
      Array.from(this.servers.values()).map(async (runtime) => {
        clearTimeout(runtime.restartTimer);
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
    if (isLocalServerConfig(runtime.config)) {
      throw new Error(`MCP gateway server "${name}" runs locally and has no OAuth flow`);
    }
    await exchangeMcpGatewayAuthorizationCode({
      serverUrl: runtime.config.url,
      provider: this.buildOAuthProvider(name),
      code,
    });
    await this.reconnect(name);
  }

  /**
   * Begins interactive OAuth for one server (U6/KTD3, R6's "one-click auth" action): drives
   * discovery + client registration + the PKCE challenge via U1's oauth module, returning the
   * authorization URL for a wire RPC to hand back to the client. Static-auth servers have
   * nothing to authorize interactively (their credential is a stored header, set out of band),
   * so they're rejected here rather than producing a URL that would never complete anything.
   */
  async startAuthorization(name: string): Promise<StartMcpGatewayAuthResult> {
    const runtime = this.servers.get(name);
    if (!runtime) {
      throw new McpGatewayActionError("unknown_server", `Unknown MCP gateway server "${name}"`);
    }
    if (runtime.config.auth === "static" || isLocalServerConfig(runtime.config)) {
      throw new McpGatewayActionError(
        "static_auth",
        `MCP gateway server "${name}" uses static auth; nothing to authorize`,
      );
    }
    const redirectUrl = this.requireOAuthRedirectUrl(name);
    // A hand-registered app's own `scope` is the operator's exact request and is sent as is,
    // offline_access included only if they listed it. Otherwise widen for a refresh token.
    const scope =
      this.tokenStore.getClientCredentials(name)?.scope ??
      (await resolveOfflineAccessScope(runtime.config.url));
    if (
      scope !== undefined &&
      !this.tokenStore.getClientCredentials(name) &&
      registrationExcludesScope(this.tokenStore.getClientInformation(name), scope)
    ) {
      // A dynamic registration made for the narrower scope may be refused the wider one at the
      // authorize step, in the browser, where nothing can explain it. Registering again is
      // what DCR is for; a hand-registered app is the operator's and is never touched.
      this.tokenStore.forgetClientInformation(name);
    }
    try {
      return await startMcpGatewayAuthorization({
        serverName: name,
        serverUrl: runtime.config.url,
        redirectUrl,
        credentialsPath: this.tokenStore.credentialsPath,
        provider: this.buildOAuthProvider(name),
        ...(scope === undefined ? {} : { scope }),
      });
    } catch (error) {
      throw toStartAuthorizationFailure(name, error);
    }
  }

  /** Same as `resolveOAuthRedirectUrl`, typed as a failure the strip can explain. */
  private requireOAuthRedirectUrl(name: string): string {
    if (!this.oauthRedirectBaseUrl) {
      throw new McpGatewayActionError(
        "no_redirect_url",
        `MCP gateway server "${name}" needs OAuth but no reachable redirect base URL is configured`,
      );
    }
    return `${this.oauthRedirectBaseUrl}/mcp/gateway/oauth/callback`;
  }

  buildOAuthProvider(name: string): OAuthClientProvider {
    return createGatewayOAuthClientProvider({
      serverName: name,
      tokenStore: this.tokenStore,
      stateStore: this.oauthStateStore,
      redirectUrl: this.resolveOAuthRedirectUrl(name),
    });
  }

  /**
   * The provider a live connection authenticates with. When the transport meets a 401 it runs
   * the SDK's `auth()`, which refreshes when it can and otherwise begins a fresh authorization:
   * minting a `state` and saving a PKCE verifier. On the interactive provider that would
   * invalidate a sign-in someone started from the strip a moment earlier and overwrite its
   * verifier, so their callback fails as an expired link. Nobody is waiting on a browser here,
   * so this one keeps both stores untouched and lets `auth()` end in `UnauthorizedError`.
   */
  private buildConnectionOAuthProvider(name: string): OAuthClientProvider {
    return {
      ...this.buildOAuthProvider(name),
      state: () => randomUUID(),
      saveCodeVerifier: () => undefined,
      redirectToAuthorization: () => undefined,
    };
  }

  private resolveOAuthRedirectUrl(name: string): string {
    if (!this.oauthRedirectBaseUrl) {
      throw new Error(
        `MCP gateway server "${name}" needs OAuth but no reachable redirect base URL is configured`,
      );
    }
    return `${this.oauthRedirectBaseUrl}/mcp/gateway/oauth/callback`;
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
          { level: "alert" },
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
          {
            // Signing in again is something only a person can do. An unresponsive server often
            // comes back on its own.
            level: transition.status === "needs-auth" ? "alert" : "notice",
            dedupeKey: `mcp-gateway:${transition.name}:${transition.status}`,
          },
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

    if (isLocalServerConfig(runtime.config)) {
      await this.connectLocalServer(name, runtime, runtime.config);
      return;
    }
    const config = runtime.config;

    try {
      let headers: Record<string, string> | undefined;
      let authProvider: OAuthClientProvider | undefined;

      if (config.auth === "static") {
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
        authProvider = this.buildConnectionOAuthProvider(name);
        // The SDK's authProvider owns Authorization; extraHeaders ride requestInit for
        // OAuth upstreams that additionally require non-auth headers (see token-store.ts).
        headers = this.tokenStore.getOAuthExtraHeaders(name);
      }

      const transport = this.buildTransport({
        url: config.url,
        transport: config.transport,
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
          : { type: "connectionFailed", error: getErrorMessage(error) },
      );
      this.logger?.warn({ err: error, server: name }, "MCP gateway server connection failed");
    }
  }

  /**
   * Spawns a local server and connects to it over stdio (docs/mcp-gateway.md "Local servers").
   * The child gets the SDK's minimal inherited environment (HOME, PATH, USER, …) plus the env
   * stored for it, never the daemon's own. A credential therefore reaches exactly the one
   * process that needs it, and sessions only ever see the gateway route.
   */
  private async connectLocalServer(
    name: string,
    runtime: McpGatewayServerRuntime,
    config: McpGatewayLocalServerConfig,
  ): Promise<void> {
    const env = this.tokenStore.getStaticEnv(name);
    if (config.auth === "static" && !env) {
      this.transitionRuntime(name, runtime, { type: "needsAuth" });
      return;
    }
    const secrets = Object.values(env ?? {});
    let stderrTail = "";
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      ...(env ? { env } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-LOCAL_SERVER_STDERR_TAIL_CHARS);
    });
    const client = new Client({ name: "paseo-mcp-gateway", version: "1.0.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      this.transitionRuntime(name, runtime, {
        type: "connectionFailed",
        error: redactValues(getErrorMessage(error), secrets),
      });
      this.logger?.warn(
        { err: error, server: name, stderr: redactValues(stderrTail, secrets) },
        "MCP gateway local server failed to start",
      );
      return;
    }
    runtime.client = client;
    runtime.connectedAt = Date.now();
    // The SDK's Client has no addEventListener; `onclose` is the only close hook it offers.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = () => this.handleLocalServerExit(name, runtime, client);
    this.transitionRuntime(name, runtime, { type: "connected" });
  }

  /** A local server that exits on its own is restarted with backoff; one closed by `stop()` or
   * replaced by a newer connection is left alone. */
  private handleLocalServerExit(
    name: string,
    runtime: McpGatewayServerRuntime,
    client: Client,
  ): void {
    if (this.stopped || runtime.client !== client) return;
    runtime.client = undefined;
    this.transitionRuntime(name, runtime, {
      type: "connectionFailed",
      error: "The local server process exited",
    });
    const uptime = Date.now() - (runtime.connectedAt ?? 0);
    const restarts = uptime >= LOCAL_SERVER_STABLE_UPTIME_MS ? 0 : (runtime.restarts ?? 0);
    runtime.restarts = restarts + 1;
    const delay = Math.min(
      LOCAL_SERVER_RESTART_BASE_MS * 2 ** restarts,
      LOCAL_SERVER_RESTART_MAX_MS,
    );
    this.logger?.warn({ server: name, delay }, "MCP gateway local server exited; restarting");
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = undefined;
      if (this.stopped) return;
      void this.reconnect(name);
    }, delay);
    runtime.restartTimer.unref?.();
  }
}
