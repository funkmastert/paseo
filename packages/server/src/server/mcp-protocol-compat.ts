import type { IncomingMessage } from "node:http";

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
 *
 * Mutates `rawHeaders`, not just `headers`: the transport reaches the SDK via
 * `@hono/node-server`, which builds its Web-standard `Request` from `IncomingMessage.rawHeaders`
 * (the wire-order name/value pairs) rather than the parsed `headers` object, so a `headers`-only
 * rewrite is invisible to it.
 */
export function normalizeMcpProtocolVersionHeader(req: IncomingMessage): void {
  const raw = req.headers[PROTOCOL_VERSION_HEADER];
  const version = Array.isArray(raw) ? raw[0] : raw;
  if (version === undefined || SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return;
  }
  req.headers[PROTOCOL_VERSION_HEADER] = LATEST_PROTOCOL_VERSION;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === PROTOCOL_VERSION_HEADER) {
      req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
    }
  }
}
