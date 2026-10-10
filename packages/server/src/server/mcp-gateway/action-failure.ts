/**
 * Why a gateway action the strip offers — brokering a session-reported server, or starting
 * sign-in for a brokered one — failed. The strip used to render each of these as
 * "Authentication failed: <sentence>", which was true for one of them. The reason travels to
 * the client so it can say what actually happened and decide whether the button is worth
 * offering again. See docs/mcp-gateway.md.
 */
export type McpGatewayFailureReason =
  /** No gateway on this host, so nothing can be brokered or signed in to. */
  | "gateway_disabled"
  /** The agent that reported the server is no longer loaded. */
  | "unknown_agent"
  /** The agent's provider cannot expose an MCP config at all. */
  | "provider_has_no_config"
  /** That provider's account is not signed in on this host. */
  | "account_signed_out"
  /** The config Paseo reads for that account has no entry with this name. */
  | "server_not_in_config"
  /** The entry exists but runs as a local command; only http and sse can be brokered. */
  | "server_is_local"
  /** The gateway refused the definition. */
  | "adopt_failed"
  /** The gateway does not broker a server by this name. */
  | "unknown_server"
  /** The server authenticates with a static header; there is no interactive sign-in. */
  | "static_auth"
  /** The daemon has no reachable base URL to hand the upstream as a redirect target. */
  | "no_redirect_url"
  /** The upstream needs an OAuth app registered by hand; sign-in never started. */
  | "client_not_registered"
  /** The upstream offers registration and refuses to register this client; credentials cannot help. */
  | "client_registration_refused"
  /** The upstream refused the request — a real OAuth error, or an HTTP status with no body. */
  | "server_rejected"
  /** The upstream could not be reached at all. */
  | "server_unreachable"
  /** Sign-in itself failed, which is the only failure that is authentication. */
  | "authorization_failed";

/**
 * How the caller can clear a failure, in parts a client composes its own sentence from. Host
 * specifics only — a path, a URI, a command — never product copy, which the app owns and
 * translates.
 */
export interface McpGatewayRemedy {
  /** A command to run on the host. */
  command?: string;
  /** A file on the host the operator has to edit. */
  path?: string;
  /** The redirect URI an upstream OAuth app must be registered with. */
  redirectUrl?: string;
}

export class McpGatewayActionError extends Error {
  constructor(
    readonly reason: McpGatewayFailureReason,
    message: string,
    readonly remedy: McpGatewayRemedy = {},
  ) {
    super(message);
    this.name = "McpGatewayActionError";
  }
}
