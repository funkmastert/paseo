import type { McpGatewaySetupKind } from "@getpaseo/protocol/messages";

import { getLocalServerPreset } from "./local-server-presets.js";

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
  /** Read lazily: they hit the token file, and most servers never reach the question. */
  hasStoredTokens(): boolean;
  hasClientCredentials(): boolean;
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
 * Whether a setup form can fix this server right now.
 *
 * A server a local-server preset replaces always offers the token form once it runs locally,
 * healthy or not: a wrong token starts fine and only fails on tool calls, so "connected" does not
 * mean the token is right. Still hosted, it offers the form while unhealthy.
 *
 * An OAuth server with no way to register an app offers the credentials form until a sign-in has
 * stored tokens, saved credentials or not: a mistyped secret saves fine and only fails at sign-in.
 */
export function deriveSetupHint(input: SetupHintInput): McpGatewaySetupKind | undefined {
  if (getLocalServerPreset(input.name)) {
    const runsLocally = input.url === undefined;
    return input.unhealthy || runsLocally ? "local_token" : undefined;
  }
  if (!input.unhealthy) return undefined;
  if (input.isStatic || input.hasStoredTokens()) return undefined;
  const host = hostOf(input.url);
  const hostRefusesRegistration = host !== undefined && NON_DCR_HOSTS.has(host);
  const needsOwnApp =
    input.registrationUnsupported || hostRefusesRegistration || input.hasClientCredentials();
  return needsOwnApp ? "client_credentials" : undefined;
}
