---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: In-app setup for MCP servers that cannot sign in on their own (Figma, Slack)"
date: 2026-10-22
---

# feat: In-app setup for MCP servers that cannot sign in on their own (Figma, Slack)

## Summary

The MCP status strip shows `figma` and `slack` as permanently broken: Figma's hosted server
refuses every client outside its catalog, and Slack has no dynamic client registration. Both
have a working path in `docs/mcp-gateway.md`, but only as hand-edited config and token files.
This adds a setup action on those rows that opens a form, and a small set of daemon RPCs that
write the credentials and config the form collects.

- **Figma, "Set up with a token":** the daemon installs a pinned Framelink
  `figma-developer-mcp` into its own directory, stores the user's personal access token in the
  token file, replaces the hosted `figma` entry with a local stdio server, and the row
  reconnects.
- **Slack, "Create a Slack app":** a three-step form (open a prefilled Slack app manifest,
  paste Client ID and Secret, sign in). The daemon writes `clientCredentials` with the
  matching `redirectUrl` and a read-only `scope`.

**Assumptions** (task brief fixed the product decisions; these fill gaps):

- The mechanism is generic (two setup kinds: `client_credentials`, `local_token`). Provider
  specifics live in two small tables: the daemon's local-server presets (Framelink), and the
  app's provider guides (Slack manifest, Figma token link).
- Which rows offer setup is decided by the daemon and sent on the status snapshot as an
  optional `setup` field, because only the daemon knows whether credentials already exist.
- All three setup RPCs require `daemon.manage`, the permission the existing gateway RPCs and
  config edits use (`docs/permissions.md`).
- Feature flag: `mcpGatewaySetup` on `server_info.features`.
- The Slack scope list is the one in Slack's MCP server docs (verified 2026-10-22), not the
  brief's list. Differences are reported in the final message.
- Screenshots use the app's vitest browser screenshot tests (the strip's existing approach),
  not the Electron capture harness, which verifies browser-pane compositing and does not
  render app screens.

---

## Problem Frame

`mcpGateway.servers.figma` is the hosted URL with `auth: oauth`, and `slack` likewise.
Pressing Sign in on either ends in `client_registration_refused` or `client_not_registered`,
and the row then tells the user to go edit a token file or give up. Both are dead ends for
someone using the app. The pieces to fix them exist in the daemon (`localServers`, stored
`clientCredentials`), so the work is the write path and the UI in front of it.

## Requirements

- **R1.** Figma row offers "Set up with a token". Saving a token installs the pinned server,
  stores the token in the token file, switches `figma` to the local stdio entry in config,
  and the row reaches connected without a daemon restart.
- **R2.** The hosted `figma` entry, if configured, is replaced through the daemon's config
  write path. The app never edits files.
- **R3.** Slack row offers "Create a Slack app" with three steps: manifest button, credential
  fields, Sign in. Credentials are written with `redirectUrl` and `scope`.
- **R4.** Slack manifest scopes are read-only. No `chat:write`, `files:write`,
  `canvases:write`, `reactions:write`, `channels:write`, `groups:write`, `im:write`,
  `mpim:write`, `lists:write`. The redirect URL is derived from the daemon's actual port.
- **R5.** The form notes that a workspace may require admin approval for a new app.
- **R6.** Both dead-end messages are replaced with copy that points at the action; the old
  explanation stays behind "More". The mechanism is reusable: a form for client id/secret with
  optional redirect and scope; a form for a local server with a token.
- **R7.** New RPCs use dotted namespaces with request/response pairs, optional new fields, a
  `server_info.features` gate, `daemon.manage`, and secrets that never come back or get logged.
- **R8.** Works on desktop, web and phone (the strip and sheet are already cross-platform).
- **R9.** Tests, screenshots, a one-off real run of the pinned Framelink package, and
  `docs/mcp-gateway.md` updated in place.

## Scope Boundaries

- No Figma or Slack API calls with real credentials; the Framelink run uses a fake token and
  only lists tools.
- No change to `claude.ai` connector handling.
- No UI for editing or removing an existing token (re-running setup replaces it).

### Deferred to Follow-Up Work

- A committed lockfile for Framelink's transitive dependencies. The install pins the
  top-level version exactly and skips lifecycle scripts; transitive ranges still float.
- A "test connection" check against Figma's or Slack's API.
- Setup forms for servers beyond the two tables (the mechanism supports a generic
  credentials form; no other provider guide ships).

---

## Key Technical Decisions

- **KTD1. Daemon-owned preset table; the client sends a preset id and a token, never a
  command.** A principal with `daemon.manage` can already edit config, but the daemon still
  should not run a command string a client composed. The table holds package, exact version,
  entry path, args, and the env var that carries the token.
- **KTD2. Install into `$PASEO_HOME/mcp-gateway/local-servers/<preset>-<version>/` with
  `npm install --ignore-scripts --no-audit --no-fund` of the exact version.** Runs via the
  existing `execCommand` (handles Windows `.cmd` shims). `command` is `process.execPath`; when
  the daemon runs under Electron, `ELECTRON_RUN_AS_NODE=1` rides in the record's `env` (the
  child's env is otherwise minimal). Install is idempotent: a present `bin` file skips it.
- **KTD3. Config removal via a patch field.** `MutableDaemonConfigPatch` gains an optional
  `removeMcpGatewayServers: string[]`, modelled on `removeProviders`. Deep-merge-only patching
  cannot delete the hosted `servers.figma` entry, and a name in both `servers` and
  `localServers` keeps the remote one (`docs/mcp-gateway.md`), so leaving it would undo the
  switch on the next boot.
- **KTD4. Live swap.** `McpGateway.replaceServer(name, config)` closes the old client, resets
  the runtime to disabled, and reconnects, so no restart is needed. The existing
  restart-required note for `mcpGateway` does not apply to this path.
- **KTD5. Daemon decides when setup is offered.** `mcp_status_update` entries gain optional
  `setup: "client_credentials" | "local_token"`. `local_token` when a preset exists for the
  name and the server is unhealthy. `client_credentials` when an OAuth server is unhealthy,
  has no stored credentials or tokens, and is known not to support registration (a
  `client_not_registered` start failure, or a table of known non-DCR hosts: `mcp.slack.com`).
  Once credentials are saved the hint clears and the row's normal Sign in returns.
- **KTD6. Redirect URL.** `describe` returns the daemon's callback URL with a loopback IP
  host rewritten to `localhost` (Slack treats only `http://localhost` as a desktop redirect).
  A public service-proxy base URL is used as is. The form passes it back on save and the
  daemon stores it as `redirectUrl`.
- **KTD7. Slack scopes come from Slack's MCP docs**, read-only subset: search
  (`search:read.public|private|mpim|im|files|users`), history (`channels|groups|im|mpim:history`),
  listing (`channels|groups|im|mpim:read`), `users:read`, `users:read.email`, `files:read`,
  `canvases:read`, `lists:read`, `reactions:read`, `emoji:read`. The gateway sends `scope`
  as written, so the stored scope is the same list.
- **KTD8. Form model follows `docs/forms.md`:** a plain TS model per form kind, fresh mount per
  open, sheet renders and dispatches. Secret fields use secure entry and are never echoed back.

## Output Structure

    packages/server/src/server/mcp-gateway/
      local-server-presets.ts     (preset table)
      local-server-installer.ts   (pinned install)
      setup.ts                    (describe / save client / local token orchestration)
    packages/app/src/mcp-status/
      mcp-setup-providers.ts      (Slack manifest, Figma token link)
      mcp-setup-form-model.ts     (+ test)
      mcp-setup-sheet.tsx         (+ browser test and screenshots)

---

## Implementation Units

### U1. Protocol: RPCs, snapshot field, feature flag, patch field

**Goal:** Define the wire surface.
**Requirements:** R7.
**Dependencies:** none.
**Files:** `packages/protocol/src/messages.ts`; protocol validation tests under
`packages/protocol/tests/`; `packages/client/src/daemon-client.ts`,
`packages/client/src/daemon-client.test.ts`.
**Approach:**

- `mcp_gateway.setup.describe.{request,response}`, `mcp_gateway.setup.save_client.{request,response}`,
  `mcp_gateway.setup.local_token.{request,response}`. Requests carry top-level params and a
  `requestId`; responses carry `payload` with `requestId`, `error`, `reason` (plain string, like
  the existing responses) and the remedy-free fields each needs. `describe` payload: `redirectUrl`,
  `clientIdSet`, `clientSecretSet`, `scope`, `tokenSet`, `presetAvailable`. No secret value ever
  appears in a response schema.
- `McpGatewayStatusEntrySchema.setup` optional enum.
- `server_info.features.mcpGatewaySetup` optional boolean with a `COMPAT(mcpGatewaySetup)` tag.
- `MutableDaemonConfigPatchSchema.removeMcpGatewayServers` optional string array.
- Client methods `describeMcpGatewaySetup`, `saveMcpGatewayClient`, `setMcpGatewayLocalToken`
  (local-token timeout above the 60 s default is not needed; install is bounded server-side).
  **Patterns to follow:** `mcp_gateway.server.adopt.*` schemas and the `removeProviders` field.
  **Test scenarios:**
- Old client parses a status entry carrying `setup` (unknown key tolerated) and a patch without
  `removeMcpGatewayServers`.
- New request schemas reject a missing `name`; accept omitted optional `redirectUrl`/`scope`.
- Client methods send the right `type` and correlate the response by `requestId`.
  **Verification:** protocol and client typecheck; protocol validators regenerate.

### U2. Token store: write credentials and static env

**Goal:** Methods to write what the forms collect.
**Requirements:** R1, R3.
**Dependencies:** none.
**Files:** `packages/server/src/server/mcp-gateway/token-store.ts`, `token-store.test.ts`.
**Approach:** `saveClientCredentials(name, creds)` patches the OAuth record's
`clientCredentials` (clearing a stale dynamic `clientInformation`, since stored credentials
outrank it); `saveStaticEnv(name, env)` writes `{auth:"static", headers:{}, env}`, keeping
`headers` required for older daemons. Both write 0600 through the existing helper.
**Test scenarios:**

- Save credentials on an empty file, then on a record with tokens: tokens survive, credentials
  and `redirectUrl`/`scope` present, file mode stays 0600.
- Saving credentials drops a previous dynamic `clientInformation`.
- `saveStaticEnv` over an OAuth record for the same name replaces it; `headers` is `{}`.
- `listSecretValues` includes the new secret and token (so the JEV redactor sees them).
  **Verification:** record round-trips through the existing schema parse.

### U3. Gateway: live replace and the setup hint

**Goal:** Swap a server at runtime and publish when setup is needed.
**Requirements:** R1, R2, KTD4, KTD5.
**Dependencies:** U1, U2.
**Files:** `packages/server/src/server/mcp-gateway/gateway.ts`, `gateway.test.ts`.
**Approach:** `replaceServer(name, config)` (enabled gateway only): stop any restart timer,
detach and close the old client without triggering the local-exit restart, install a fresh
disabled runtime, `notifyStatusChange`, `connectServer`, flush notifications. `getSnapshot`
adds `setup` per KTD5; a runtime flag records a `client_not_registered` failure from
`startAuthorization`, and `saveClientCredentials` clears it. Add `setLocalServerPersister` or a
single config-writer hook parallel to `setServerPersister`.
**Test scenarios:**

- Replace a remote `figma` with a local entry that has stored env: status goes connecting then
  connected; the old client is closed once; no restart timer fires from the old runtime.
- Replace with a local entry and no env: lands in needs-auth, never spawned.
- Snapshot carries `setup: "local_token"` for an unhealthy `figma` with a preset, and none once
  connected; carries `client_credentials` for an unhealthy `mcp.slack.com` OAuth server with no
  credentials, and none once credentials exist.
- A `client_not_registered` start failure on an unlisted host raises `client_credentials`.
  **Verification:** existing gateway tests still pass.

### U4. Config store: remove gateway servers

**Goal:** Persist the figma switch durably.
**Requirements:** R2, KTD3.
**Dependencies:** U1.
**Files:** `packages/server/src/server/daemon-config-store.ts`,
`packages/server/src/server/config-mcp-gateway.test.ts` (or `daemon-config-store.test.ts`).
**Approach:** carry `removeMcpGatewayServers` through `pickSupportedPatchFields`, delete the
names from the merged live config and from the persisted `mcpGateway.servers`, in the same
write as the `localServers` addition. Rolled back with the rest on a failed apply.
**Test scenarios:**

- Patch `{ mcpGateway: { localServers: { figma } }, removeMcpGatewayServers: ["figma"] }` on a
  config with hosted `servers.figma`: both live config and `config.json` show `figma` only
  under `localServers`; other servers untouched.
- Removing a name that is absent is a no-op write.
  **Verification:** persisted file re-parses under the strict persisted schema.

### U5. Local-server presets and the pinned installer

**Goal:** Install Framelink at an exact version and describe how to run it.
**Requirements:** R1, KTD1, KTD2.
**Dependencies:** none.
**Files:** `packages/server/src/server/mcp-gateway/local-server-presets.ts`,
`local-server-installer.ts`, `local-server-installer.test.ts`.
**Approach:** `figma` preset: package `figma-developer-mcp`, version `0.13.2`, entry
`dist/bin.js`, args `--stdio --no-telemetry --skip-image-downloads`, token env
`FIGMA_API_KEY`. Installer takes an injected command runner (default `execCommand("npm", …)`),
creates the directory, installs, verifies the entry exists, returns the resolved launch spec
(`command`, `args`, non-secret `env`). Errors carry npm's stderr tail with the token absent.
**Execution note:** the real install is exercised once by hand in a scratch dir (U9), not in
unit tests.
**Test scenarios:**

- Fresh dir: runs npm with the exact pinned spec and `--ignore-scripts`, returns the launch spec.
- Entry already present: skips npm.
- npm exits non-zero: throws an error naming the failure with stderr tail; no partial launch spec.
- Under Electron (`process.versions.electron` set), spec env includes `ELECTRON_RUN_AS_NODE=1`.
  **Verification:** launch spec paths are absolute and stay inside the install dir.

### U6. Setup service and session handlers

**Goal:** Orchestrate the three RPCs and enforce permission.
**Requirements:** R1–R4, R7.
**Dependencies:** U1–U5.
**Files:** `packages/server/src/server/mcp-gateway/setup.ts`, `setup.test.ts`,
`packages/server/src/server/session.ts`, `session.test.ts`,
`packages/server/src/server/agent/agent-manager.ts` (thin wrappers like the existing ones),
`packages/server/src/server/bootstrap.ts` (wire the config writer),
`packages/server/src/server/websocket-server.ts` (feature flag),
`packages/server/src/server/authorization/operation-permissions.ts`,
`packages/server/src/server/authorization/index.test.ts`.
**Approach:**

- `describe`: redirect URL per KTD6, booleans only.
- `save_client`: validate `clientId` non-empty, `clientSecret` optional, `redirectUrl` must be a
  URL ending in the gateway callback path, `scope` space-separated non-empty if present; write
  via the token store; clear the gateway's not-registered flag; broadcast status.
- `local_token`: look up the preset (reject unknown with `no_local_preset`), reject an empty
  token, install, write static env (token plus the launch spec's non-secret env), patch config
  (`localServers[name]`, `removeMcpGatewayServers: [name]`), `replaceServer`, return the
  resulting status.
- Failures use `McpGatewayActionError` reasons; new reasons: `invalid_input`, `no_local_preset`,
  `install_failed`, `config_write_failed`. Responses carry reason plus the daemon's sentence;
  logs record the server name and reason only.
  **Test scenarios:**
- `local_token` happy path with a fake installer: token file has `env.FIGMA_API_KEY`, config has
  `localServers.figma` and no `servers.figma`, gateway replaced, response `error: null`.
- Same RPC from a principal without `daemon.manage` is rejected before the handler runs.
- Empty token → `invalid_input`; unknown preset → `no_local_preset`; installer failure →
  `install_failed` and the hosted entry and token file are unchanged.
- `save_client` writes `clientCredentials` with `redirectUrl` and `scope`; bad redirect path
  rejected; secret absent from the response and from every captured log line.
- `describe` never includes the secret or token; loopback base URL rewritten to `localhost`.
- Gateway disabled → `gateway_disabled`.
  **Verification:** operation-permissions exhaustiveness holds; session tests green.

### U7. App model and row action

**Goal:** Offer the action and route it.
**Requirements:** R1, R3, R6, R8.
**Dependencies:** U1.
**Files:** `packages/app/src/mcp-status/mcp-status-strip-model.ts` (+ test),
`mcp-status-copy.ts` (+ test), `use-mcp-status.ts` (+ test), `mcp-status-strip.tsx`,
`mcp-status-strip-view.tsx`.
**Approach:** `McpStatusServerEntry.setup`; new `McpStatusRowAction` `"setup"` set when the
entry has `setup` and the host has `mcpGatewaySetup`, taking precedence over `authenticate` and
surviving terminal failures. `row.setupKind` carried for routing. `actionLabelText`: provider
label (Figma "Set up with a token", Slack "Create a Slack app") else generic "Set up".
`failureText`/`secondLineText`: when `row.action === "setup"`, the two dead-end reasons and the
no-failure state get pointer copy; `remedyLines` appends a "Why" line holding the old
explanation (behind More). An old daemon keeps today's copy. The strip holds the open sheet
state and renders it.
**Test scenarios:**

- Entry with `setup` and flag on → action `setup`; flag off → unchanged `authenticate`.
- `client_not_registered` failure with setup on: second line is the pointer sentence, expandable,
  and the old explanation appears as a remedy line; with setup off, the old text is the line.
- After credentials saved (`setup` absent): action returns to `authenticate`.
  **Verification:** existing strip model and copy tests pass.

### U8. Setup sheet, form model, provider table, i18n

**Goal:** The two forms.
**Requirements:** R1, R3–R6, R8.
**Dependencies:** U7.
**Files:** `packages/app/src/mcp-status/mcp-setup-providers.ts`, `mcp-setup-form-model.ts`
(+ test), `mcp-setup-sheet.tsx`, `packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts`.
**Approach:** Providers table: Slack manifest builder (name "Paseo MCP", redirect URL passed in,
scopes from KTD7, `https://api.slack.com/apps?new_app=1&manifest_json=<encoded>`), Figma
personal-access-token link and the scope hint (read-only file scopes). Form model per `docs/forms.md`:
`openLocalTokenForm`, `openClientCredentialsForm` with commands, derived `canSubmit`, submission
state `idle | saving | saved | error(reason)`. Sheet: `AdaptiveModalSheet`, `Field`,
`FormTextInput` with secure entry for secrets; Slack body has the three numbered steps, Sign in
disabled until credentials are saved, and the admin-approval note. Sign in reuses `startAuth`.
Translations delegated as a mechanical task once `en.ts` is final.
**Test scenarios:**

- Local-token form: empty/whitespace token blocks submit; trimmed token submits; server error
  surfaces; secret field never shows the saved value on reopen.
- Credentials form: client id required, secret optional, redirect must be a URL, scope
  space-separated; Sign in disabled until saved; manifest URL decodes to JSON whose scopes are
  read-only and whose redirect equals the one passed in.
- Locale parity test passes for all nine files.
  **Verification:** browser test renders both sheets at desktop and phone widths.

### U9. Browser tests, screenshots, real Framelink run, docs

**Goal:** Prove it and write it down.
**Requirements:** R9.
**Dependencies:** U1–U8.
**Files:** `packages/app/src/mcp-status/mcp-setup-sheet.screenshot.browser.test.tsx`,
`docs/mcp-gateway.md`.
**Approach:** Browser test mounts each sheet, checks validation and gating through the DOM, and
captures PNGs to `/tmp`. One-off scratch install of `figma-developer-mcp@0.13.2` in a temp dir,
started through the MCP SDK stdio client with a fake token to list tools (no Figma API call).
Rewrite the "Servers with a pre-registered OAuth app" and "Local servers" sections and the
"provider that will not have us" remedy text so the app flow is primary and the file shapes are
"what it writes"; add the feature flag to the adopt/feature notes; keep doc voice rules.
**Test scenarios:** covered above; plus the DOM check that the Slack manifest button's URL
decodes to the expected manifest.
**Verification:** screenshots exist; the scratch run lists Framelink's tools.

---

## System-Wide Impact

- **Wire:** four optional additions (status `setup`, patch `removeMcpGatewayServers`, feature
  flag, six new message types). An old app ignores `setup`; an old daemon never sends it and
  lacks the flag, so the app shows today's rows.
- **Secrets:** client secret and token travel app to daemon only, then live in the 0600 token
  file. Inbound messages are only trace-logged by type and size. Responses and logs omit them.
- **Windows and macOS:** install and spawn go through `execCommand`/`StdioClientTransport`,
  which already handle Windows command shims and Electron-as-node.

## Risks & Dependencies

- **Slack may refuse an unlisted app on its MCP endpoint.** Slack's docs say only
  directory-published or internal apps may use MCP; a workspace-created internal app should
  qualify, but this cannot be proven without real credentials. The form states the admin
  approval caveat; the final report flags this.
- **npm may be missing from the daemon's environment.** The error names it and keeps the hosted
  entry unchanged.
- **Install time.** Bounded by an install timeout; the RPC awaits it and the sheet shows a
  saving state (client RPC default is 60 s).
- **Transitive dependency drift** until a lockfile ships (deferred).

## Documentation Plan

Integrate into `docs/mcp-gateway.md` as described in U9; no new doc, no new `CLAUDE.md` row.

## Sources & Research

- `docs/mcp-gateway.md` (Local servers, pre-registered OAuth app, provider that will not have us).
- Slack MCP server docs, `https://docs.slack.dev/ai/slack-mcp-server` (scopes per tool; only
  directory-published or internal apps may use MCP).
- npm registry: `figma-developer-mcp` latest 0.13.2, MIT, node >=20.20.
