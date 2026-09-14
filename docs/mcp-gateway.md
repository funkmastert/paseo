# MCP gateway

The daemon authenticates to external MCP servers once and re-exposes them to every agent session it creates, on every configured provider account. Sessions talk to stable daemon-local routes (`/mcp/gateway/<name>`) behind a dedicated capability token; the daemon holds the upstream credentials and relays traffic. An account swap or re-login never requires MCP re-authentication, and a re-auth at the daemon takes effect for already-running sessions without a restart.

Server code lives in `packages/server/src/server/mcp-gateway/`. The app surface is the MCP status strip in the sidebar (`packages/app/src/mcp-status/`).

## Configuration

Add an `mcpGateway` section to the daemon config (`~/.paseo/config.json`):

```json
{
  "mcpGateway": {
    "enabled": true,
    "servers": {
      "zeeq": { "url": "https://zeeq.example.com/mcp", "transport": "http", "critical": true },
      "agent-gateway": {
        "url": "https://gw.example.com/mcp",
        "transport": "http",
        "critical": true
      },
      "github": { "url": "https://api.githubcopilot.com/mcp/", "transport": "http" },
      "internal-tool": {
        "url": "https://tool.example.com/mcp",
        "transport": "sse",
        "auth": "static"
      }
    }
  }
}
```

- `transport`: `http` (streamable HTTP) or `sse`.
- `critical`: critical-tier servers get named in the collapsed strip when unhealthy and fire an immediate push notification on auth loss or unavailability. Non-critical servers change strip state only.
- `auth`: `oauth` (default) or `static`. Secrets never go in this config — it is broadcast to every connected client. Static header values live in the private token store (below).
- `sessionMode`: `overlay` (default) or `strict`. How brokered entries meet the CLI's own MCP loading; see Session injection.
- Adding a server is configuration only; no code. Editing `mcpGateway` requires a daemon restart — the config store persists the change and reports it as restart-required.

When the gateway is disabled or unconfigured, nothing is constructed and session launches are byte-identical to a gateway-less daemon.

## Auth flow

1. The strip shows a server as needs-auth. Press its auth button.
2. The client calls `mcp_gateway.auth.start` and opens the returned authorization URL externally.
3. The provider redirects to `/mcp/gateway/oauth/callback` on the daemon's reachable base URL. The daemon exchanges the code (PKCE, single-use state), persists tokens, reconnects upstream, and broadcasts `mcp_status_update` — running sessions' next tool call succeeds.

The redirect URL is the daemon's own reachable address (the service-proxy public URL when configured, else the loopback listen address). Phone-initiated auth requires the daemon to be reachable from the network the browser lands on; on a loopback-only daemon, complete auth from a device that can reach the daemon directly.

Static-auth servers have nothing to authorize interactively; store their header values in the token store keyed by server name.

## Tokens

All upstream credentials — OAuth tokens, dynamic client registrations, PKCE verifiers, static headers — live in `$PASEO_HOME/mcp-gateway/tokens.json`, written 0600 via the daemon's private-file helper. Tokens never appear in config, wire payloads, or logs. Bulk rotation beyond per-server re-auth from the strip is not implemented; delete the file and re-auth to start over.

## Session injection

Claude sessions launched while the gateway is enabled receive the brokered servers as per-launch `mcpServers` entries (never persisted, stripped from storage like the `paseo` entry). `sessionMode` decides what happens to everything else the CLI would load:

- `overlay` (default): the brokered entries ride `--mcp-config` next to the CLI's own user, project, and local scopes and its claude.ai connectors. A launch-time entry wins a name collision with a per-dir entry, so a brokered `github` shadows a stale user-scope `github`. Per-dir entries the gateway does not broker keep loading and keep failing on their own; remove them with `claude mcp remove <name> -s user` in that account's config dir.
- `strict`: also sets `strictMcpConfig`, which stops every per-dir definition from loading. Per-dir stdio entries from the config dir's `.claude.json` and the project `.mcp.json` are re-read and re-injected with `${VAR}`/`${VAR:-default}` expansion; local-scope entries (`projects.<dir>.mcpServers`) are not. Strict also drops claude.ai connectors, which live on the account rather than in any file the daemon can re-inject. That is why it is not the default.

Both facts (collision precedence, connector drop) were measured by launching `claude -p --output-format stream-json --verbose` and reading the init message's `mcp_servers` list, against Claude Code 2.1.270 on 2026-09-14. Re-measure the same way when the CLI's MCP loading changes.

Per-session MCP statuses reported by the SDK at init are captured onto the agent (live-only) and surface in the strip grouped by server: one session-reported row per server name with a reporter count, no auth action, because the daemon holds no credential for that server. When the gateway has no servers of its own, those rows still drive the collapsed summary — it names them rather than reading "connected".
