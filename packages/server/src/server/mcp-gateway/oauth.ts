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

  create(serverName: string, now: number = Date.now()): string {
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
 * (discovery, dynamic registration, PKCE challenge), capturing the URL it
 * would otherwise hand a browser — the daemon is headless, so the caller (a
 * wire RPC, added in U6) returns the URL to the client to open instead.
 *
 * Live network coverage of this path (real discovery/DCR against a fixture
 * upstream) belongs to U2's local e2e suite alongside the callback route;
 * this unit's tests cover the state store and provider plumbing that feed it.
 */
export async function startMcpGatewayAuthorization(params: {
  serverUrl: string;
  provider: OAuthClientProvider;
}): Promise<StartMcpGatewayAuthResult> {
  let capturedUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    ...params.provider,
    redirectToAuthorization: (url: URL) => {
      capturedUrl = url;
    },
  };

  const result = await runOAuthOrchestration(provider, { serverUrl: params.serverUrl });
  if (result !== "REDIRECT" || !capturedUrl) {
    throw new Error(
      `Expected MCP gateway auth start to produce a redirect for "${params.serverUrl}"`,
    );
  }
  return { authorizationUrl: capturedUrl.toString() };
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
