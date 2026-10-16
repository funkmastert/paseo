# Residual review findings — MCP auth gateway

Source: ce-code-review run `20260912-225824-7cf575a6` (9 personas + independent validation) over `058f26d5a..619ec7abb`, plan `docs/plans/2026-09-12-008-feat-mcp-auth-gateway-plan.md`. Applied fixes landed in `619ec7abb`; this file records what was deliberately not applied. Tracker filing: not available (GitHub Issues disabled on this fork; `gh` authenticated) — items below are the durable record.

## Unapplied actionable (no_sink)

- **P2 — `packages/app/src/mcp-status/mcp-status-strip-model.ts:159` — canAuth cannot distinguish static-auth servers.** The applied slice surfaces the auth RPC's resolved error inline, so a press is no longer silent — but the button still renders for static-auth servers that can never be interactively authed. Remainder: add an additive-optional auth-mode field to `McpGatewayStatusEntrySchema` (wire change) and exclude `auth: "static"` servers from `canAuth`. Deferred because it changes a wire contract; do it beside the next protocol touch. (reliability; validated)

## Validator-dropped (recorded for context)

- **stdio local scope** (`per-dir-stdio.ts`): `.claude.json`'s `projects[<dir>].mcpServers` entries are not re-injected — a documented v1 boundary (KTD5), and this machine's only project-scoped server is remote zeeq, already brokered. If local-scope (`claude mcp add` default) stdio servers appear later, they would silently vanish under `strictMcpConfig` until per-dir-stdio.ts learns that scope. (agent-native + correctness; dropped by validator as deliberate scope)
- **Upstream error text on the wire** (`gateway.ts` connectionFailed): within SECURITY.md's trusted-operator model; bounding it is hygiene, not a vulnerability. (security; dropped by validator)

## Demoted P3s (mechanical cleanups for a rainy day)

- Three verbatim `Pick<McpGateway, ...>` unions in `agent-manager.ts` — extract a shared `McpGatewayHandle` alias. (maintainability, c100)
- `mcp-status-strip-model.ts` hand-duplicates the gateway status union — derive from `McpGatewayStatusEntry["status"]`. (maintainability, c75)

## Residual risks (report-only)

- No liveness detection on an established upstream connection: a critical server dying mid-day without a 401/403 never leaves `connected`, so the strip and R11's push stay quiet until the next explicit reconnect. Needs a mid-session failure hook (also unblocks black-box episode re-arm testing). Strongest follow-up candidate. (adversarial + reliability + U5 implementation notes)
- Gateway facade advertises tools only; upstream resources/prompts are invisible through brokered servers. Fine for the current R9 set; revisit if a brokered server ships resources. (agent-native)
- `McpGatewayOAuthStateStore` never sweeps expired entries (memory-only growth); `stop()` closes clients without state transitions (brief shutdown-window staleness). (reliability)
- `tokens.json` read-modify-write has no file locking; near-simultaneous multi-field writes could race last-writer-wins. (maintainability)
- OAuth token-endpoint error bodies land verbatim in `daemon.log` via the SDK's raw-body fallback — redact before sharing logs. (security)
- Env-var expansion in stdio re-injection is inferred from documented `.mcp.json` syntax, not verified against the minified SDK source. (U3 implementation note)
- No automatic retry/backoff for a server in `error` status; recovery rides the strip's Reauth button (which forces a retry transition even for non-auth failures — non-obvious from UI copy). (reliability)
- New require cycle `host-runtime.ts -> push-router.ts -> use-mcp-status.ts -> host-runtime.ts` (browser-test console; repo tolerates cycles but this one is new — break by moving the query key/apply helper out of the hook module). (browser smoke)

## Testing gaps (union)

- Concurrent `startAuthorization` race coverage now exists (last-start-wins tests); still untested: a start racing an in-flight callback.
- Established-connection death post-connect (distinct from 401/403) flipping state + firing the critical notification.
- `mcp_status_update` error-field content bounds; per-message legacy-replica case in `wire-compat.test.ts` (currently proven in `session.test.ts`).
- Strip Reauth against a static-auth server in `error` state (partially covered by the new inline-error test).

No `settled_conflict`-stamped findings and no `settled_decision_conflicts` from implementation — nothing conflicted with the plan's session-settled decisions.
