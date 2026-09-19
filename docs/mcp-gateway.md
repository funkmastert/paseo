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

### Servers with a pre-registered OAuth app

Step 2 registers a client with the upstream on the fly (RFC 7591 dynamic client registration). Plenty of servers — Slack among them — never offer that: their authorization-server metadata has no `registration_endpoint`, and you are expected to create an OAuth app in their own console. Sign-in on those fails until you give the daemon that app's credentials.

Put them in the token store, not config — a client secret is a secret, and config is broadcast to every connected client. The server name in `mcpGateway.servers` is the reference; the record under the same name holds the credential, exactly as for static-auth headers:

```json
{
  "version": 1,
  "servers": {
    "slack": {
      "auth": "oauth",
      "clientCredentials": { "clientId": "…", "clientSecret": "…" }
    }
  }
}
```

Omit `clientSecret` for a public client. Register the app's redirect URI as the daemon's `/mcp/gateway/oauth/callback` URL — the error the strip shows when credentials are missing names the exact URL to use. The daemon re-reads `tokens.json` on every credential lookup, so pressing sign in again picks the record up without a restart.

Stored credentials outrank anything a past dynamic registration saved, and the SDK never registers when they are present, so the hand-written record is never overwritten.

## Adopting a session-reported server

Agents also load MCP servers from their own Claude config (user scope in the account's `.claude.json`, the project `.mcp.json`, local scope). Those show in the strip as session-reported rows, annotated with the account that reported them. Pressing **Broker & sign in** on one calls `mcp_gateway.server.adopt`: the daemon reads the definition the way the CLI would for that session — local scope first, then the project `.mcp.json`, then user scope, with `${VAR}` expanded against the session's provider env (`per-dir-stdio.ts`) — adds the server to the live gateway, persists it into `mcpGateway.servers`, and starts OAuth in the same call. The first scope that names the server decides, even when its entry turns out to be a local command: falling through would broker a definition the session is not using. A definition that already carries an `Authorization` header becomes a static-auth server and connects at once; other headers ride along as extra headers on the OAuth record. Adopted servers are non-critical; edit config to change that.

Which account's `.claude.json` that is comes from the agent's own provider, not the one it extends. A derived provider (`extends: "claude"` with its own `CLAUDE_CONFIG_DIR`) is a separate account with a separate config file, and adopting from the base provider's would broker a definition the session never loaded. The provider's `env` value is `${VAR}`-expanded the same way a definition's fields are. `wrapClientProvider` rebuilds a client field by field, so anything the adopt path asks a client — `resolveMcpConfigScope`, `describeAccountAuth` — has to be forwarded there or every derived provider silently answers for the base account.

claude.ai connectors (`claude.ai …`) live on the Claude account, not in any file, so their row opens claude.ai's connector settings instead. Gate the button on `server_info.features.mcpGatewayAdopt`; an older daemon shows the row with no action.

### When adopting fails

The response carries a `reason` beside its `error` sentence, because one sentence cannot be both a log line and the thing a person reads — and because the strip cannot decide whether to keep offering the button without knowing the cause. `adopt-failure.ts` owns the vocabulary:

| Reason                   | What happened                                            | Can the button help? |
| ------------------------ | -------------------------------------------------------- | -------------------- |
| `gateway_disabled`       | No gateway on this host                                  | No                   |
| `unknown_agent`          | The reporting agent is no longer loaded                  | No                   |
| `provider_has_no_config` | That provider cannot expose an MCP config at all         | No                   |
| `account_signed_out`     | The provider's account is not signed in                  | No — `remedyCommand` |
| `server_not_in_config`   | The config Paseo reads has no entry with that name       | No                   |
| `server_is_local`        | It has one, as a local command; only http and sse broker | No                   |
| `adopt_failed`           | The gateway refused the definition                       | Yes                  |
| `authorization_failed`   | OAuth failed after the definition was adopted            | Yes                  |

Only the last one is authentication. The strip withdraws the action for the rest and shows the reason in its place; it never withdraws one on a reason it does not recognise, so a daemon naming a new cause degrades to "still offered" rather than to a dead row.

`account_signed_out` is read structurally: the CLI writes `oauthAccount` into the account's own `.claude.json` on login and drops it on logout, so the check is a read of the file adopt already opens rather than a `claude auth status` subprocess. It is deliberately one-directional. The token lives in the OS keychain, so the key's presence is not proof the account still works — only its absence is acted on, and a provider that cannot answer says `unknown`, which nothing infers a failure from.

Two things the daemon cannot tell you, and the copy does not pretend otherwise. It does not know where an agent loaded a server it cannot find — a plugin, a claude.ai connector, and a config file outside the scopes above are indistinguishable from "absent". And when an account is signed out _and_ the server is missing, it reports the account: that is the more upstream fact and the one with a fix, not a claim that signing in will make that particular server appear.

## Tokens

All upstream credentials — OAuth tokens, client registrations (dynamic or pre-registered), PKCE verifiers, static headers — live in `$PASEO_HOME/mcp-gateway/tokens.json`, written 0600 via the daemon's private-file helper. Tokens never appear in config, wire payloads, or logs. Bulk rotation beyond per-server re-auth from the strip is not implemented; delete the file and re-auth to start over.

## Session injection

Claude sessions launched while the gateway is enabled receive the brokered servers as per-launch `mcpServers` entries (never persisted, stripped from storage like the `paseo` entry). `sessionMode` decides what happens to everything else the CLI would load:

- `overlay` (default): the brokered entries ride `--mcp-config` next to the CLI's own user, project, and local scopes and its claude.ai connectors. A launch-time entry wins a name collision with a per-dir entry, so a brokered `github` shadows a stale user-scope `github`. Per-dir entries the gateway does not broker keep loading and keep failing on their own; remove them with `claude mcp remove <name> -s user` in that account's config dir.
- `strict`: also sets `strictMcpConfig`, which stops every per-dir definition from loading. Per-dir stdio entries from the config dir's `.claude.json` and the project `.mcp.json` are re-read and re-injected with `${VAR}`/`${VAR:-default}` expansion; local-scope entries (`projects.<dir>.mcpServers`) are not. Strict also drops claude.ai connectors, which live on the account rather than in any file the daemon can re-inject. That is why it is not the default.

Both facts (collision precedence, connector drop) were measured by launching `claude -p --output-format stream-json --verbose` and reading the init message's `mcp_servers` list, against Claude Code 2.1.270 on 2026-09-14. Re-measure the same way when the CLI's MCP loading changes.

Per-session MCP statuses reported by the SDK at init are captured onto the agent (live-only) and surface in the strip grouped by server: one session-reported row per server name with a reporter count, no auth action, because the daemon holds no credential for that server. When the gateway has no servers of its own, those rows still drive the collapsed summary — it names them rather than reading "connected".
