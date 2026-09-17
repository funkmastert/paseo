import { randomUUID } from "node:crypto";

import {
  auth as runOAuthOrchestration,
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
  provider: OAuthClientProvider;
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
    result = await runOAuthOrchestration(provider, { serverUrl: params.serverUrl });
  } catch (error) {
    if (isDynamicClientRegistrationUnsupported(error)) {
      throw new MissingOAuthClientError(params.serverName, params.redirectUrl);
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

// The SDK raises this from `registerClient()` when the authorization server's metadata has no
// `registration_endpoint`. It reads as a defect in the server; it is really a request for a
// credential only the operator can supply, so it gets rewritten rather than surfaced.
const DCR_UNSUPPORTED_SDK_MESSAGE = "does not support dynamic client registration";

function isDynamicClientRegistrationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DCR_UNSUPPORTED_SDK_MESSAGE);
}

/**
 * Raised instead of the SDK's DCR complaint when a server needs an OAuth app registered by hand.
 * The message is what the MCP status strip shows, so it names the file to edit, the shape to
 * write, and the redirect URI the upstream app has to be registered with — none of which the
 * user can derive from "incompatible auth server".
 */
export class MissingOAuthClientError extends Error {
  constructor(
    readonly serverName: string,
    readonly redirectUrl: string,
  ) {
    super(
      `MCP server "${serverName}" does not support dynamic client registration, so it needs an ` +
        `OAuth app you register yourself. Register one with redirect URI ${redirectUrl}, then add ` +
        `its credentials to $PASEO_HOME/mcp-gateway/tokens.json as servers."${serverName}" = ` +
        `{"auth":"oauth","clientCredentials":{"clientId":"…","clientSecret":"…"}} ` +
        `(omit clientSecret if the server issues none) and sign in again.`,
    );
    this.name = "MissingOAuthClientError";
  }
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
