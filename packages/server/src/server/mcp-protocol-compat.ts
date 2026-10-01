import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/**
 * Our `/mcp/*` endpoints are stateless: every HTTP request builds a fresh
 * `StreamableHTTPServerTransport`, so each one independently validates the
 * `Mcp-Protocol-Version` header against the SDK's `SUPPORTED_PROTOCOL_VERSIONS` and 400s
 * on a mismatch. `initialize` itself already negotiates down to a version we support when
 * the client asks for one we don't recognize (the SDK's `Server` falls back to
 * `LATEST_PROTOCOL_VERSION`), but a client that echoes back the version it originally
 * requested — rather than the one the server actually negotiated — fails every request
 * after that, even though the session is otherwise healthy. Rewrite the header the same
 * way `initialize` would before the SDK sees it, so a newer-than-us client degrades to our
 * latest version instead of getting rejected outright.
 */
export function normalizeMcpProtocolVersionHeader(
  headers: Record<string, string | string[] | undefined>,
): void {
  const raw = headers[PROTOCOL_VERSION_HEADER];
  const version = Array.isArray(raw) ? raw[0] : raw;
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    headers[PROTOCOL_VERSION_HEADER] = LATEST_PROTOCOL_VERSION;
  }
}
