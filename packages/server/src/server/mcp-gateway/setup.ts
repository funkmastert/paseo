import { getErrorMessage } from "@getpaseo/protocol/error-utils";

import { McpGatewayActionError } from "./action-failure.js";
import type { McpGateway, McpGatewayLocalServerConfig } from "./gateway.js";
import {
  installLocalServer,
  type InstallLocalServerInput,
  type LocalServerLaunchSpec,
} from "./local-server-installer.js";
import { getLocalServerPreset } from "./local-server-presets.js";
import type { McpGatewayTokenStore } from "./token-store.js";

/** The path every upstream OAuth app must send the browser back to. */
export const OAUTH_CALLBACK_PATH = "/mcp/gateway/oauth/callback";

/** Names end up in a route path and a config key, so they stay plain. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface McpGatewaySetupDescription {
  redirectUrl: string;
  clientIdSet: boolean;
  clientSecretSet: boolean;
  scope: string | null;
  tokenSet: boolean;
}

export interface SaveClientInput {
  name: string;
  clientId: string;
  clientSecret?: string;
  redirectUrl?: string;
  scope?: string;
}

export interface SetLocalTokenInput {
  name: string;
  preset: string;
  token: string;
}

/** Writes the local entry to config, dropping any hosted entry of the same name in that write. */
export type LocalServerConfigWriter = (name: string, config: McpGatewayLocalServerConfig) => void;

export interface McpGatewaySetupServiceOptions {
  paseoHome: string;
  gateway: McpGateway;
  tokenStore: McpGatewayTokenStore;
  writeLocalServer: LocalServerConfigWriter;
  /** Replaceable in tests; defaults to the real pinned install. */
  install?: (input: InstallLocalServerInput) => Promise<LocalServerLaunchSpec>;
}

function invalid(message: string): McpGatewayActionError {
  return new McpGatewayActionError("invalid_input", message);
}

/**
 * The callback URL an upstream OAuth app must allow. A loopback IP becomes `localhost`, the
 * only form Slack accepts as a desktop redirect; a public base URL is used as is.
 */
export function deriveCallbackUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    url.hostname = "localhost";
  }
  return `${url.origin}${OAUTH_CALLBACK_PATH}`;
}

function normalizeScope(scope: string | undefined): string | undefined {
  const normalized = scope?.split(/\s+/).filter(Boolean).join(" ");
  return normalized ? normalized : undefined;
}

function normalizeRedirectUrl(redirectUrl: string | undefined): string | undefined {
  const trimmed = redirectUrl?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid("The redirect URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("The redirect URL must be an http or https URL");
  }
  if (parsed.pathname !== OAUTH_CALLBACK_PATH || parsed.search || parsed.hash) {
    throw invalid(`The redirect URL must end in ${OAUTH_CALLBACK_PATH}, this daemon's callback`);
  }
  return parsed.toString();
}

/**
 * The write path behind the strip's setup forms (docs/mcp-gateway.md "Setting up a server that
 * cannot sign in"). Everything here validates, then writes to the token file and config the
 * daemon already owns; no secret is returned to the caller, and none is logged.
 */
export class McpGatewaySetupService {
  private readonly install: NonNullable<McpGatewaySetupServiceOptions["install"]>;

  constructor(private readonly options: McpGatewaySetupServiceOptions) {
    this.install = options.install ?? installLocalServer;
  }

  private requireEnabled(): void {
    if (!this.options.gateway.enabled) {
      throw new McpGatewayActionError("gateway_disabled", "MCP gateway is not enabled");
    }
  }

  describe(name: string): McpGatewaySetupDescription {
    this.requireEnabled();
    if (!this.options.gateway.getServerState(name)) {
      throw new McpGatewayActionError("unknown_server", `Unknown MCP gateway server "${name}"`);
    }
    const baseUrl = this.options.gateway.getOAuthRedirectBaseUrl();
    if (!baseUrl) {
      throw new McpGatewayActionError(
        "no_redirect_url",
        `The daemon has no reachable address for ${name} to send you back to`,
      );
    }
    const credentials = this.options.tokenStore.getClientCredentials(name);
    const env = this.options.tokenStore.getStaticEnv(name);
    return {
      redirectUrl: deriveCallbackUrl(baseUrl),
      clientIdSet: credentials !== undefined,
      clientSecretSet: credentials?.clientSecret !== undefined,
      scope: credentials?.scope ?? null,
      tokenSet: env !== undefined && Object.keys(env).length > 0,
    };
  }

  saveClient(input: SaveClientInput): void {
    this.requireEnabled();
    const { gateway, tokenStore } = this.options;
    if (!gateway.getServerState(input.name)) {
      throw new McpGatewayActionError(
        "unknown_server",
        `Unknown MCP gateway server "${input.name}"`,
      );
    }
    if (!gateway.isRemoteServer(input.name)) {
      throw new McpGatewayActionError(
        "server_is_local",
        `${input.name} runs as a local command, so it has no OAuth app to register`,
      );
    }
    const clientId = input.clientId.trim();
    if (!clientId) {
      throw invalid("The client ID is required");
    }
    const clientSecret = input.clientSecret?.trim() || undefined;
    const redirectUrl = normalizeRedirectUrl(input.redirectUrl);
    const scope = normalizeScope(input.scope);
    tokenStore.saveClientCredentials(input.name, {
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(redirectUrl === undefined ? {} : { redirectUrl }),
      ...(scope === undefined ? {} : { scope }),
    });
    gateway.clearRegistrationUnsupported(input.name);
    gateway.refreshStatus();
  }

  /**
   * Installs the preset, stores the token for it, switches the named entry to the local server
   * in config, and replaces the live runtime. The install runs first so a failure leaves the
   * hosted entry, the token file and the config exactly as they were.
   */
  async setLocalToken(input: SetLocalTokenInput): Promise<{ status: string }> {
    this.requireEnabled();
    const { gateway, tokenStore, paseoHome } = this.options;
    if (!SERVER_NAME_PATTERN.test(input.name)) {
      throw invalid("The server name may only use letters, digits, dots, dashes and underscores");
    }
    const preset = getLocalServerPreset(input.preset);
    if (!preset) {
      throw new McpGatewayActionError(
        "no_local_preset",
        `The daemon has no local server called "${input.preset}"`,
      );
    }
    const token = input.token.trim();
    if (!token) {
      throw invalid("The token is required");
    }
    if (/\s/.test(token)) {
      throw invalid("The token must not contain spaces or line breaks");
    }

    const spec = await this.install({ paseoHome, preset });
    const config: McpGatewayLocalServerConfig = {
      command: spec.command,
      args: spec.args,
      auth: "static",
    };
    tokenStore.saveStaticEnv(input.name, { ...spec.env, [preset.tokenEnv]: token });
    try {
      this.options.writeLocalServer(input.name, config);
    } catch (error) {
      throw new McpGatewayActionError(
        "config_write_failed",
        `The token was stored but the config could not be written: ${getErrorMessage(error)}`,
      );
    }
    return { status: await gateway.replaceServer(input.name, config) };
  }
}
