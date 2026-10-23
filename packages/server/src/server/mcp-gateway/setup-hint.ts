import { getLocalServerPreset } from "./local-server-presets.js";

/** The two things the in-app setup form can fix, as the status snapshot names them. */
export type McpGatewaySetupKind = "client_credentials" | "local_token";

/**
 * Hosts whose authorization server offers no dynamic client registration, so signing in can
 * never start without a hand-made OAuth app. A host missing from this list still reaches the
 * same hint after its first sign-in fails with `client_not_registered`.
 */
const NON_DCR_HOSTS: ReadonlySet<string> = new Set(["mcp.slack.com"]);

export interface SetupHintInput {
  name: string;
  /** The server's URL; absent for a local server. */
  url: string | undefined;
  /** Whether the entry authenticates with a stored header or env rather than OAuth. */
  isStatic: boolean;
  unhealthy: boolean;
  hasStoredTokens: boolean;
  hasClientCredentials: boolean;
  /** A sign-in already failed because the upstream has no dynamic registration. */
  registrationUnsupported: boolean;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Whether a setup form can fix this server right now. A server a local-server preset replaces
 * offers the token form for as long as it is unhealthy; an OAuth server with no app registered
 * and no way to register one offers the credentials form until credentials exist, after which
 * the row's ordinary Sign in is what is left to do.
 */
export function deriveSetupHint(input: SetupHintInput): McpGatewaySetupKind | undefined {
  if (!input.unhealthy) return undefined;
  if (getLocalServerPreset(input.name)) return "local_token";
  if (input.isStatic || input.hasStoredTokens || input.hasClientCredentials) return undefined;
  const host = hostOf(input.url);
  if (input.registrationUnsupported || (host !== undefined && NON_DCR_HOSTS.has(host))) {
    return "client_credentials";
  }
  return undefined;
}
