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

Omit `clientSecret` for a public client. Register the app's redirect URI as the daemon's `/mcp/gateway/oauth/callback` URL. Two optional fields cover providers that are fussy about either:

- `redirectUrl`: the URI you registered, when the provider will not accept the one the daemon derives. It must still reach this daemon's callback path. The loopback daemon derives `http://127.0.0.1:<port>/…`, and Slack only treats `http://localhost` redirects as desktop redirects, so register and set `http://localhost:6767/mcp/gateway/oauth/callback`.
- `scope`: the space-separated scopes to request. Without it the SDK requests everything the resource advertises in `scopes_supported`, which for Slack includes posting, writing canvases, and uploading files as you.

Both fields are ignored by daemons older than this feature, and such a daemon rewrites the file without them the next time it saves a token, so upgrade the daemon before you add them. You do not have to derive any of this: sign-in fails with `client_not_registered`, and the strip shows the exact redirect URI, the resolved path of this file, and the JSON to add, with a copy button — it is the one failure whose whole point is to be read and followed. The daemon re-reads `tokens.json` on every credential lookup, so pressing sign in again picks the record up without a restart.

Stored credentials outrank anything a past dynamic registration saved, and the SDK never registers when they are present, so the hand-written record is never overwritten.

## When an action fails

Both actions the strip offers — **Authenticate** on a brokered server and **Broker & sign in** on a session-reported one — answer with a `reason` beside their `error` sentence. One sentence cannot be both a log line and the thing a person reads, and the strip cannot decide whether the button is still worth offering without knowing the cause. `action-failure.ts` owns one vocabulary for both:

| Reason                        | What happened                                            | Can the button help?  |
| ----------------------------- | -------------------------------------------------------- | --------------------- |
| `gateway_disabled`            | No gateway on this host                                  | No                    |
| `unknown_agent`               | The reporting agent is no longer loaded                  | No                    |
| `provider_has_no_config`      | That provider cannot expose an MCP config at all         | No                    |
| `account_signed_out`          | The provider's account is not signed in                  | No — `remedyCommand`  |
| `server_not_in_config`        | The config Paseo reads has no entry with that name       | No                    |
| `server_is_local`             | It has one, as a local command; only http and sse broker | No                    |
| `adopt_failed`                | The gateway refused the definition                       | Yes                   |
| `unknown_server`              | The gateway brokers nothing by that name                 | No                    |
| `static_auth`                 | Its credential is a stored header, set out of band       | No                    |
| `no_redirect_url`             | The daemon has no reachable address to be sent back to   | No                    |
| `client_not_registered`       | The upstream needs an OAuth app registered by hand       | No — `remedy*`        |
| `client_registration_refused` | It offers registration and refuses to register us        | No — not fixable here |
| `server_rejected`             | The upstream refused the request                         | Yes                   |
| `server_unreachable`          | The upstream could not be reached                        | Yes                   |
| `authorization_failed`        | Sign-in itself failed                                    | Yes                   |

Only the last one is authentication. The strip withdraws the action for the "no" rows and shows the reason in its place; it never withdraws one on a reason it does not recognise, so a daemon naming a new cause degrades to "still offered" rather than to a dead row. `server_rejected` and `server_unreachable` stay actionable on purpose: an upstream that is down or refusing now may not be in a minute, and removing the only way to find out is worse than a button that sometimes fails again.

A remedy travels as host specifics — `remedyCommand`, `remedyPath`, `remedyRedirectUrl` — never as a composed sentence. The client owns the wording and translates it; the daemon owns the paths and URIs, which no translation should touch. Nothing in a remedy is a secret.

`account_signed_out` is read structurally: the CLI writes `oauthAccount` into the account's own `.claude.json` on login and drops it on logout, so the check is a read of the file adopt already opens rather than a `claude auth status` subprocess. It is deliberately one-directional. The token lives in the OS keychain, so the key's presence is not proof the account still works — only its absence is acted on, and a provider that cannot answer says `unknown`, which nothing infers a failure from.

Two things the daemon cannot tell you, and the copy does not pretend otherwise. It does not know where an agent loaded a server it cannot find — a plugin, a claude.ai connector, and a config file outside the scopes below are indistinguishable from "absent". And when an account is signed out _and_ the server is missing, it reports the account: that is the more upstream fact and the one with a fix, not a claim that signing in will make that particular server appear.

### A provider that will not have us

`client_not_registered` and `client_registration_refused` look alike and have opposite remedies.
The first means the upstream does not offer dynamic registration, so you create an OAuth app and
put its credentials in the token file. The second means it _does_ offer registration, over a
`registration_endpoint` it advertises, and then refuses — so there is nothing to supply and the
copy must not send anyone hunting for credentials.

Figma is the worked example, measured on the wire on 2026-09-19. Discovery is entirely healthy:
`/.well-known/oauth-protected-resource/mcp` returns 200 naming `https://api.figma.com` as the
authorization server, that server's metadata returns 200 and advertises
`registration_endpoint: https://api.figma.com/v1/oauth/mcp/register`, and the MCP endpoint itself
answers an unauthenticated call with a correct `401` plus a `WWW-Authenticate` header. Only the
registration POST fails, with `403` and a nine-byte `Forbidden` body sent as
`content-type: application/json` — which is what produced the SDK's "Invalid OAuth error
response: SyntaxError" in the strip. Every payload shape, an empty body, and a bearer token all
get the identical 403, so nothing about the request is being judged. Figma's documentation states
the rule: "Only clients listed in the Figma MCP Catalog can connect to the Figma MCP Server."

The daemon tells the two apart by what had happened when the SDK threw: the upstream answered
with a status, no client information was stored, and no authorization URL was produced, so the
flow never got past registration. A network failure is excluded from that test — an upstream
nobody could reach refused nothing.

### What the SDK says, and what we say instead

Two upstream messages are rewritten rather than passed through, because both describe the daemon's internals to someone who wanted to know about their own server.

`parseErrorResponse` JSON-parses an error body and, when that fails, reports the parse failure: `HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F', "Forbidden" is not valid JSON. Raw body: Forbidden`. Nobody can act on a `SyntaxError`. `describeOAuthFailure` keeps the two parts that mean something — the status code and the body — and says `figma refused the sign-in request with HTTP 403 and said: Forbidden.` A long body is clipped; an OAuth error with no description at all falls back to naming its error class; a connection that never landed is `server_unreachable`, not a refusal.

The DCR complaint becomes `client_not_registered` with the redirect URI and the resolved token-file path attached, which is what the next section is about.

## Adopting a session-reported server

Agents also load MCP servers from their own Claude config (user scope in the account's `.claude.json`, the project `.mcp.json`, local scope). Those show in the strip as session-reported rows, annotated with the account that reported them. Pressing **Broker & sign in** on one calls `mcp_gateway.server.adopt`: the daemon reads the definition the way the CLI would for that session — local scope first, then the project `.mcp.json`, then user scope, with `${VAR}` expanded against the session's provider env (`per-dir-stdio.ts`) — adds the server to the live gateway, persists it into `mcpGateway.servers`, and starts OAuth in the same call. The first scope that names the server decides, even when its entry turns out to be a local command: falling through would broker a definition the session is not using. A definition that already carries an `Authorization` header becomes a static-auth server and connects at once; other headers ride along as extra headers on the OAuth record. Adopted servers are non-critical; edit config to change that.

Which account's `.claude.json` that is comes from the agent's own provider, not the one it extends. A derived provider (`extends: "claude"` with its own `CLAUDE_CONFIG_DIR`) is a separate account with a separate config file, and adopting from the base provider's would broker a definition the session never loaded. The provider's `env` value is `${VAR}`-expanded the same way a definition's fields are. `wrapClientProvider` rebuilds a client field by field, so anything the adopt path asks a client — `resolveMcpConfigScope`, `describeAccountAuth` — has to be forwarded there or every derived provider silently answers for the base account.

claude.ai connectors (`claude.ai …`) live on the Claude account, not in any file, so their row opens claude.ai's connector settings instead. Gate the button on `server_info.features.mcpGatewayAdopt`; an older daemon shows the row with no action.

## Tokens

All upstream credentials — OAuth tokens, client registrations (dynamic or pre-registered), PKCE verifiers, static headers — live in `$PASEO_HOME/mcp-gateway/tokens.json`, written 0600 via the daemon's private-file helper. Tokens never appear in config, wire payloads, or logs. Bulk rotation beyond per-server re-auth from the strip is not implemented; delete the file and re-auth to start over.

## Session injection

Claude sessions launched while the gateway is enabled receive the brokered servers as per-launch `mcpServers` entries (never persisted, stripped from storage like the `paseo` entry). `sessionMode` decides what happens to everything else the CLI would load:

- `overlay` (default): the brokered entries ride `--mcp-config` next to the CLI's own user, project, and local scopes and its claude.ai connectors. A launch-time entry wins a name collision with a per-dir entry, so a brokered `github` shadows a stale user-scope `github`. Per-dir entries the gateway does not broker keep loading and keep failing on their own; remove them with `claude mcp remove <name> -s user` in that account's config dir.
- `strict`: also sets `strictMcpConfig`, which stops every per-dir definition from loading. Per-dir stdio entries from the config dir's `.claude.json` and the project `.mcp.json` are re-read and re-injected with `${VAR}`/`${VAR:-default}` expansion; local-scope entries (`projects.<dir>.mcpServers`) are not. Strict also drops claude.ai connectors, which live on the account rather than in any file the daemon can re-inject. That is why it is not the default.

Both facts (collision precedence, connector drop) were measured by launching `claude -p --output-format stream-json --verbose` and reading the init message's `mcp_servers` list, against Claude Code 2.1.270 on 2026-09-14. Re-measure the same way when the CLI's MCP loading changes.

Per-session MCP statuses reported by the SDK at init are captured onto the agent (live-only) and surface in the strip grouped by server: one session-reported row per server name with a reporter count, no auth action, because the daemon holds no credential for that server. When the gateway has no servers of its own, those rows still drive the collapsed summary — it names them rather than reading "connected".
