import { randomUUID } from "node:crypto";

import {
  auth as runOAuthOrchestration,
  discoverOAuthServerInfo,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpGatewayTokenStore } from "./token-store.js";

const DEFAULT_STATE_TTL_MS = 5 * 60_000;

interface OAuthStateEntry {
  readonly serverName: string;
  readonly expiresAt: number;
}

/**
 * Single-use, short-lived `state` bookkeeping for the OAuth authorization-code
 * flow (KTD3). A value is minted when auth starts and removed the moment it's
 * consumed — on the callback's first success or failure alike — so a replayed
 * callback request can never be accepted twice.
 */
export class McpGatewayOAuthStateStore {
  private readonly entries = new Map<string, OAuthStateEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_STATE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Invalidates a prior state before minting the new one — last-start-wins semantics.
   * Two devices starting auth for the same server otherwise both mint a valid state, but
   * the PKCE code verifier in the token store is keyed by serverName only (KTD4), so the
   * second start's `saveCodeVerifier()` silently clobbers the first's. Without this, the
   * first device's callback would reach the exchange and fail on a mismatched verifier —
   * confusing, since nothing about that error says "someone else restarted this flow".
   * Invalidating the old state here makes the first callback fail fast on the existing
   * unknown/expired-state 400 path instead, and guarantees the verifier a callback ever
   * successfully exchanges against always belongs to the one state that can still consume.
   */
  create(serverName: string, now: number = Date.now()): string {
    this.invalidateFor(serverName);
    const state = randomUUID();
    this.entries.set(state, { serverName, expiresAt: now + this.ttlMs });
    return state;
  }

  /** Removes the entry unconditionally, so a state value is never usable twice. */
  consume(state: string, now: number = Date.now()): string | undefined {
    const entry = this.entries.get(state);
    this.entries.delete(state);
    if (!entry || entry.expiresAt < now) {
      return undefined;
    }
    return entry.serverName;
  }

  /** Removes any existing state entries for a server. Called from `create()` so starting a
   * new auth flow always invalidates an in-flight one for the same server. */
  invalidateFor(serverName: string): void {
    for (const [state, entry] of this.entries) {
      if (entry.serverName === serverName) {
        this.entries.delete(state);
      }
    }
  }
}

export interface McpGatewayOAuthProviderOptions {
  serverName: string;
  tokenStore: McpGatewayTokenStore;
  stateStore: McpGatewayOAuthStateStore;
  /** The daemon's own stable reachable base URL (KTD3) — never a literal loopback. */
  redirectUrl: string;
  /**
   * Captures the URL the SDK would otherwise navigate a browser to. The
   * daemon is headless: the caller hands this URL back over the wire so a
   * client (phone or desktop) can open it.
   */
  onRedirect?: (url: URL) => void;
}

/**
 * Builds the SDK's `OAuthClientProvider` for one brokered server, backed by
 * the 0600 token store (KTD4) instead of in-memory or Keychain state. Tokens,
 * dynamic-registration client info, and the PKCE verifier never leave the
 * store.
 */
export function createGatewayOAuthClientProvider(
  options: McpGatewayOAuthProviderOptions,
): OAuthClientProvider {
  const { serverName, tokenStore, stateStore, redirectUrl, onRedirect } = options;

  return {
    get redirectUrl(): string {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [redirectUrl],
        client_name: "Paseo MCP Gateway",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state(): string {
      return stateStore.create(serverName);
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      // Returning anything here makes the SDK skip dynamic client registration entirely, so
      // hand-supplied credentials are what let the gateway sign in to servers that never
      // offered DCR. They outrank a stored registration: an operator who wrote a client id
      // into the token store means that app, not whatever a past DCR sweep produced.
      const preregistered = tokenStore.getClientCredentials(serverName);
      if (preregistered) {
        return {
          client_id: preregistered.clientId,
          ...(preregistered.clientSecret === undefined
            ? {}
            : { client_secret: preregistered.clientSecret }),
        };
      }
      return tokenStore.getClientInformation(serverName);
    },
    saveClientInformation(clientInformation: OAuthClientInformationFull): void {
      tokenStore.saveClientInformation(serverName, clientInformation);
    },
    tokens(): OAuthTokens | undefined {
      return tokenStore.getOAuthTokens(serverName);
    },
    saveTokens(tokens: OAuthTokens): void {
      tokenStore.saveOAuthTokens(serverName, tokens);
    },
    redirectToAuthorization(authorizationUrl: URL): void {
      onRedirect?.(authorizationUrl);
    },
    saveCodeVerifier(codeVerifier: string): void {
      tokenStore.saveCodeVerifier(serverName, codeVerifier);
    },
    codeVerifier(): string {
      const codeVerifier = tokenStore.getCodeVerifier(serverName);
      if (!codeVerifier) {
        throw new Error(`No PKCE code verifier stored for MCP gateway server "${serverName}"`);
      }
      return codeVerifier;
    },
  };
}

export interface StartMcpGatewayAuthResult {
  authorizationUrl: string;
}

/**
 * Begins the PKCE authorization-code flow for one server (F1/F3's "click
 * auth" action). Drives the SDK's `auth()` orchestrator end to end
 * (discovery, client registration, PKCE challenge), capturing the URL it
 * would otherwise hand a browser — the daemon is headless, so the caller (a
 * wire RPC, added in U6) returns the URL to the client to open instead.
 *
 * Registration is dynamic only when the token store holds no pre-registered client for the
 * server; when it does, the SDK uses that one and never asks the upstream to register.
 *
 * Live network coverage of this path (real discovery/DCR against a fixture
 * upstream) belongs to U2's local e2e suite alongside the callback route;
 * this unit's tests cover the state store and provider plumbing that feed it.
 */
export async function startMcpGatewayAuthorization(params: {
  serverName: string;
  serverUrl: string;
  /** Named in the pre-registration error: the URI the operator's own OAuth app must allow. */
  redirectUrl: string;
  /** Named in the same error: the file the operator writes the client credentials into. */
  credentialsPath: string;
  provider: OAuthClientProvider;
  /** Overrides the SDK's own scope choice; see `resolveOfflineAccessScope`. */
  scope?: string;
}): Promise<StartMcpGatewayAuthResult> {
  let capturedUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    ...params.provider,
    redirectToAuthorization: (url: URL) => {
      capturedUrl = url;
    },
  };

  let result: Awaited<ReturnType<typeof runOAuthOrchestration>>;
  try {
    result = await runOAuthOrchestration(provider, {
      serverUrl: params.serverUrl,
      ...(params.scope === undefined ? {} : { scope: params.scope }),
    });
  } catch (error) {
    if (isDynamicClientRegistrationUnsupported(error)) {
      throw new MissingOAuthClientError(
        params.serverName,
        params.redirectUrl,
        params.credentialsPath,
      );
    }
    // The upstream answered with a status, nothing was registered, and no browser redirect was
    // produced: the flow never got past client registration, so what it refused is this client
    // rather than anything about the request. Measured against Figma — every payload shape, an
    // empty body, and a bearer token all answer 403 "Forbidden" identically. A network failure
    // is deliberately excluded here; an upstream nobody could reach refused nothing.
    const refusedByUpstream =
      describeOAuthFailure(params.serverName, error).reason === "server_rejected";
    if (refusedByUpstream && !capturedUrl && !(await params.provider.clientInformation())) {
      throw new ClientRegistrationRefusedError(params.serverName, describeHttpRefusal(error));
    }
    throw error;
  }
  if (result !== "REDIRECT" || !capturedUrl) {
    throw new Error(
      `Expected MCP gateway auth start to produce a redirect for "${params.serverUrl}"`,
    );
  }
  return { authorizationUrl: capturedUrl.toString() };
}

const OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * The scope to ask for when the SDK's own choice would cost a refresh token. The SDK requests
 * exactly the resource's `scopes_supported`, and some authorization servers issue a refresh
 * token only for `offline_access`, which they list in their own metadata and the resource does
 * not. Zeeq is the worked example, measured 2026-09-21: the resource advertises `mcp:tools`,
 * the server advertises `offline_access` and the `refresh_token` grant, and a sign-in for
 * `mcp:tools` alone gets a one-hour token with nothing to renew it — another sign-in every
 * hour. Undefined leaves the SDK's choice alone: discovery failed (the SDK will say why), the
 * resource names no scopes (asking for `offline_access` alone would narrow the grant), or
 * `offline_access` is already requested or not offered.
 */
export async function resolveOfflineAccessScope(serverUrl: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(serverUrl);
  } catch {
    return undefined;
  }
  const requested = info.resourceMetadata?.scopes_supported ?? [];
  const offered = info.authorizationServerMetadata?.scopes_supported ?? [];
  if (
    requested.length === 0 ||
    requested.includes(OFFLINE_ACCESS_SCOPE) ||
    !offered.includes(OFFLINE_ACCESS_SCOPE)
  ) {
    return undefined;
  }
  return [...requested, OFFLINE_ACCESS_SCOPE].join(" ");
}

/** Whether a dynamic registration was made for a scope list that leaves `scope` out. */
export function registrationExcludesScope(
  clientInformation: OAuthClientInformationFull | undefined,
  scope: string,
): boolean {
  const registered = clientInformation?.scope;
  if (registered === undefined) {
    // A registration that names no scopes restricts none.
    return false;
  }
  const registeredScopes = new Set(registered.split(" "));
  return scope.split(" ").some((entry) => !registeredScopes.has(entry));
}

// The SDK raises this from `registerClient()` when the authorization server's metadata has no
// `registration_endpoint`. It reads as a defect in the server; it is really a request for a
// credential only the operator can supply, so it gets rewritten rather than surfaced.
const DCR_UNSUPPORTED_SDK_MESSAGE = "does not support dynamic client registration";

function isDynamicClientRegistrationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DCR_UNSUPPORTED_SDK_MESSAGE);
}

/**
 * Raised instead of the SDK's DCR complaint when a server needs an OAuth app registered by hand.
 * Sign-in never starts, so this is not an authentication failure; it is a request for a
 * credential only the operator can supply. The message stays a complete sentence for logs and
 * for a client too old to read `reason`, while the two host facts a person needs — the redirect
 * URI to register and the file to write — also travel structurally so the app can lead with
 * them instead of burying them at the end of a paragraph.
 */
export class MissingOAuthClientError extends Error {
  constructor(
    readonly serverName: string,
    readonly redirectUrl: string,
    readonly credentialsPath: string,
  ) {
    super(
      `MCP server "${serverName}" needs an OAuth app you register yourself: it does not support ` +
        `dynamic client registration. Register an app with redirect URI ${redirectUrl}, then put ` +
        `its client id and secret in ${credentialsPath} under ` +
        `servers."${serverName}".clientCredentials and sign in again.`,
    );
    this.name = "MissingOAuthClientError";
  }
}

/**
 * Raised when an upstream advertises dynamic client registration and then refuses to perform it.
 * Distinct from `MissingOAuthClientError`, where registration is not offered and the operator's
 * own OAuth app is the answer: here supplying credentials fixes nothing, because the provider
 * will not accept this client at all. Figma is the worked example — its docs say only clients in
 * its own catalog may connect, and its registration endpoint returns a bare 403 to everyone else.
 */
export class ClientRegistrationRefusedError extends Error {
  constructor(
    readonly serverName: string,
    readonly refusal: string,
  ) {
    super(
      `MCP server "${serverName}" refused to register Paseo as a client (${refusal}). Some ` +
        `providers only accept MCP clients from their own allowlist, so this is not something ` +
        `credentials or configuration can change. Check whether the provider offers a local ` +
        `server you can point this entry at instead.`,
    );
    this.name = "ClientRegistrationRefusedError";
  }
}

/** "HTTP 403" when the upstream gave one, else the raw message, for naming a refusal compactly. */
function describeHttpRefusal(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const status = /^(?:HTTP (\d{3}): )/.exec(raw)?.[1];
  return status ? `HTTP ${status}` : raw;
}

/**
 * The SDK's fallback when an upstream answers an OAuth request with something that is not an
 * OAuth error body: it JSON-parses the body, fails, and reports the parse failure. What reached
 * the strip was `HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F',
 * "Forbidden" i…` — a message about a parser, for a person who wanted to know their request was
 * refused. The status code and the body are the parts worth keeping.
 */
const INVALID_OAUTH_ERROR_BODY =
  /^(?:HTTP (\d{3}): )?Invalid OAuth error response: .*?\. Raw body: ([\s\S]*)$/;

const MAX_UPSTREAM_BODY_CHARS = 120;

export interface OAuthFailureDescription {
  reason: "server_rejected" | "server_unreachable" | "authorization_failed";
  message: string;
}

/**
 * Turns whatever the SDK's `auth()` threw into something a person can act on. Network failures
 * and upstream refusals are different problems with different next steps, and neither is the
 * authorization step failing.
 */
export function describeOAuthFailure(serverName: string, error: unknown): OAuthFailureDescription {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.trim().length === 0) {
    // The SDK builds an OAuth error from `error_description`, which the spec lets a server omit.
    // The class name is then the only thing left that says anything.
    const kind = error instanceof Error ? error.name : "unknown error";
    return {
      reason: "server_rejected",
      message: `${serverName} refused the sign-in request (${kind}).`,
    };
  }
  const unparseable = INVALID_OAUTH_ERROR_BODY.exec(raw);
  if (unparseable) {
    const status = unparseable[1];
    const body = summarizeUpstreamBody(unparseable[2] ?? "");
    const statusClause = status ? ` with HTTP ${status}` : "";
    const bodyClause = body ? ` and said: ${body}` : " and gave no reason";
    return {
      reason: "server_rejected",
      message: `${serverName} refused the sign-in request${statusClause}${bodyClause}.`,
    };
  }
  if (isNetworkFailure(error)) {
    return {
      reason: "server_unreachable",
      message: `${serverName} could not be reached: ${raw}`,
    };
  }
  return { reason: "authorization_failed", message: raw };
}

function summarizeUpstreamBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  return collapsed.length > MAX_UPSTREAM_BODY_CHARS
    ? `${collapsed.slice(0, MAX_UPSTREAM_BODY_CHARS)}…`
    : collapsed;
}

// Node reports a failed connection as a TypeError from fetch with a `cause`; the SDK does not
// wrap it, so the shape is all there is to go on.
function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(error.message)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(cause.message)
  );
}

/**
 * Completes the PKCE authorization-code flow after the daemon's OAuth
 * callback route (U2) receives `code`. On success the SDK calls
 * `provider.saveTokens()`, which persists to the token store.
 */
export async function exchangeMcpGatewayAuthorizationCode(params: {
  serverUrl: string;
  provider: OAuthClientProvider;
  code: string;
}): Promise<void> {
  const result = await runOAuthOrchestration(params.provider, {
    serverUrl: params.serverUrl,
    authorizationCode: params.code,
  });
  if (result !== "AUTHORIZED") {
    throw new Error(`MCP gateway OAuth exchange did not complete for "${params.serverUrl}"`);
  }
}

export { UnauthorizedError };
