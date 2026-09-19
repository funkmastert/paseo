/**
 * Why brokering a session-reported MCP server failed. The strip used to render every one of
 * these as "Authentication failed: <sentence>", which was true for exactly one of them. The
 * reason travels to the client so it can say what actually happened and decide whether
 * retrying could ever help. See docs/mcp-gateway.md.
 */
export type McpAdoptFailureReason =
  /** No gateway on this host, so nothing can be brokered. */
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
  /** The definition was adopted and OAuth then failed — the only case that is authentication. */
  | "authorization_failed";

/** Reasons a person could plausibly clear by pressing the button again. */
const RETRYABLE_REASONS: ReadonlySet<McpAdoptFailureReason> = new Set([
  "adopt_failed",
  "authorization_failed",
]);

export function isRetryableAdoptFailure(reason: McpAdoptFailureReason): boolean {
  return RETRYABLE_REASONS.has(reason);
}

export class McpAdoptError extends Error {
  constructor(
    readonly reason: McpAdoptFailureReason,
    message: string,
    /** A command that would clear it, when the cause has one. Never a Paseo action. */
    readonly remedyCommand: string | null = null,
  ) {
    super(message);
    this.name = "McpAdoptError";
  }
}
