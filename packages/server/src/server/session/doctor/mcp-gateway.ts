import { readFileSync } from "node:fs";
import path from "node:path";
import { finding, type DoctorCheck } from "./context.js";

interface TokenStore {
  servers?: Record<string, { tokens?: { access_token?: unknown } }>;
}

function readTokenStore(paseoHome: string): TokenStore {
  try {
    return JSON.parse(readFileSync(path.join(paseoHome, "mcp-gateway", "tokens.json"), "utf8"));
  } catch {
    // No store yet: every OAuth server reads as never signed in.
    return {};
  }
}

function hasStoredLogin(
  server: Record<string, unknown>,
  stored: NonNullable<TokenStore["servers"]>[string] | undefined,
): boolean {
  return server["auth"] === "static"
    ? stored !== undefined
    : typeof stored?.tokens?.access_token === "string";
}

/**
 * OAuth servers behind the daemon's MCP gateway with no stored login. Sessions still start; the
 * server's tools just answer needs-auth. Access-token expiry is not checked here: the store keeps
 * `expires_in` without an issue time, and the gateway renews on demand.
 */
export const mcpGatewayCheck: DoctorCheck = {
  id: "mcp.gateway",
  category: "mcp",
  timeoutMs: 5_000,
  async run(ctx) {
    const gateway = ctx.rawConfig?.["mcpGateway"] as Record<string, unknown> | undefined;
    const servers = gateway?.["servers"] as Record<string, Record<string, unknown>> | undefined;
    if (!gateway || gateway["enabled"] === false || !servers || Object.keys(servers).length === 0) {
      return [];
    }
    const store = readTokenStore(ctx.paseoHome);
    const out = [];
    let signedIn = 0;
    let total = 0;
    for (const [name, server] of Object.entries(servers)) {
      if (server["auth"] === undefined || server["auth"] === "none") continue;
      total += 1;
      const hasToken = hasStoredLogin(server, store.servers?.[name]);
      if (hasToken) {
        signedIn += 1;
        continue;
      }
      const critical = server["critical"] === true;
      out.push(
        finding(
          "mcp.gateway",
          "mcp",
          critical ? "fail" : "warn",
          `${name}: not signed in${critical ? " (critical)" : ""}`,
          {
            detail: "The gateway holds no credential for this server.",
            why: critical
              ? "Every session's tools for this server answer needs-auth. It is marked critical, so agents depend on it."
              : "Sessions that reach for this server's tools get needs-auth.",
            fix: `Open the MCP strip in the Bozeo sidebar and sign in to ${name}.`,
          },
        ),
      );
    }
    if (out.length === 0 && total > 0) {
      out.push(
        finding(
          "mcp.gateway",
          "mcp",
          "ok",
          `MCP gateway: ${signedIn} of ${total} authenticated servers have a stored login`,
        ),
      );
    }
    return out;
  },
};
