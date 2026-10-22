---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: PRs tab in the Explorer sidebar"
date: 2026-10-22
---

# feat: PRs tab in the Explorer sidebar

## Summary

Replace the single "PR #N" Explorer sidebar tab with a "PRs" tab that lists every pull
request opened by a workspace's agent or any of its descendant subagents (including
archived ones), with live status, and opens the existing checks/timeline detail view for
any row. Detection comes from a new durable per-agent PR-creation ledger in
`packages/server`, modeled on the compaction ledger (PR #75). Status comes from widening
the existing forge poll machinery to track arbitrary PR identities, not just the
checkout's own branch.

**Assumptions** (no upstream requirements doc; task brief fixed the product decisions —
see "Decisions already made" in the invocation context):

- Ledger retention: 2,000 rows / 180 days (compaction ledger uses 5,000/90; PRs are
  sparser but higher-value per row).
- Feature flag name: `pullRequestLedger` on `server_info.features`.
- New RPC family: `workspace.pullRequests.list.{request,response}` for the list, and
  `checkout.forge.get_pull_request_status.{request,response}` for status-by-identity.
- Server-side background status sweep for open tracked PRs: every 5 minutes. Client
  foreground refetch while the tab is visible: every 60 seconds (reads the server's
  already-maintained cache; does not itself trigger new forge calls).
- First-class repoint-by-identity support ships for GitHub and Gitea/Forgejo/Codeberg
  (the two forge families Tyler uses). Other registered forges fall back to opening the
  PR URL for the detail view, per the user's explicit fallback instruction.
- New doc: `docs/pull-request-ledger.md`, mirroring `docs/insights.md`'s treatment of the
  compaction ledger. Added as a CLAUDE.md docs-table row.

---

## Problem Frame

Today `packages/app/src/panels/pull-request-availability.ts` and
`packages/app/src/panels/pull-request/` derive exactly one PR per checkout: the one
attached to the checkout's current branch (`useCheckoutPrStatusQuery` ->
`checkout_pr_status_request` -> `ForgeService.getCurrentPullRequestStatus`, keyed by
`cwd` + `headRef`). That is the PR the Explorer sidebar's "PR #N" tab shows.

A leader session routinely delegates to subagents that work in their own worktrees and
open their own PRs. None of those PRs are the checkout's own branch PR, so Tyler has to
ask the agent which PRs exist. Nothing records PR creation anywhere durable, and the PR
detail pane (checks + timeline) has no way to target a PR that isn't "the current
checkout's branch."

## Requirements

- **R1**: A "PRs" tab replaces the "PR #N" tab in the compact Explorer sidebar, always
  present on git workspaces (not conditional on a PR existing).
- **R2**: The tab lists every PR opened by the workspace's agent(s) or any descendant
  subagent (including archived descendants), deduplicated by forge identity against the
  workspace branch's own PR.
- **R3**: Each row shows live status (checks rollup, review decision, open/merged/closed).
- **R4**: Tapping a row opens the existing checks/timeline detail view, repointed at that
  row's PR; falls back to the PR URL only where repointing isn't supported.
- **R5**: No new sidebar chip — tab only.
- **R6**: Status refreshes on tab open, ~60s while visible, and a cheaper background
  sweep every few minutes for still-open PRs; merged/closed PRs stop being polled.
- **R7**: Protocol stays backward compatible; the feature is gated once on
  `server_info.features.pullRequestLedger`. An app talking to an old daemon (or an old
  app talking to a new daemon) shows the old single-PR-tab behavior.
- **R8**: Every new string ships in every locale file the app bundles.

## Key Technical Decisions

**KTD1 — Detection taps the live timeline, not a log file.** Unlike the compaction
ledger (which backfills from structured `daemon.log` lines the monitor already writes),
there is no durable timeline store today (`docs/agent-lifecycle.md`; confirmed: timeline
lives in `AgentManager`'s in-memory `InMemoryAgentTimelineStore`, replayed per-agent from
provider-native transcripts on load). So detection is a new observer on
`AgentManager.recordTimeline` (`packages/server/src/server/agent/agent-manager.ts:7144`),
mirroring the existing `subscribeOperatorSignals` / `subscribeTokenBurn` listener-set
pattern (`agent-manager.ts:2230-2242`), rather than a log scraper.

**KTD2 — Backfill is a boot-time scan of already-resident agents, not a transcript
reader.** True backfill (reading every provider's native transcript format directly) is
out of scope — it would mean writing a parser per provider (Claude Code, Codex, Copilot,
OpenCode, Pi) with no shared shape. Instead, at daemon boot the new
`PullRequestLedgerService` scans the timeline rows already held in memory for every
currently-resident agent (idle agents stay resident indefinitely per
`docs/agent-lifecycle.md`) through the same detection function the live observer uses.
This catches every leader session that's been running since before this feature shipped.
**Known gap** (recorded in Scope Boundaries): a `closed` agent not resident at boot won't
be backfilled until it's next opened or prompted — loading replays its provider history
through `recordTimeline` (`agent-lifecycle.md`: "Opening or prompting the agent runs
through `ensureAgentLoaded()`... Provider history is not appended again when the
canonical timeline is already primed"), which the live observer then detects as a
byproduct. This is a one-time cost paid the first time an old closed agent is reopened
after this feature ships.

**KTD3 — Detection parses three shapes, all already captured verbatim.** Research
confirmed `ToolCallDetail` (`agent-sdk-types.ts:267-364`) already captures a shell tool's
full `output` text (`type: "shell"`) and an unrecognized (MCP) tool's full `input`/
`output` JSON (`type: "unknown"`) untruncated. Detection is a pure function per shape:

- `shell` detail whose `command` matches `gh pr create`, `tea pulls create`, or
  `tea pr create` — parse the created PR's URL out of the command's stdout (both `gh`
  and `tea` print the PR URL on success).
- `unknown` detail whose tool name is `create_pull_request` (GitHub MCP) — parse
  `html_url`/`number` out of the JSON result.
- `shell` detail whose `command` matches `gh api .* /pulls` with a POST method — parse
  the JSON response body for `html_url`/`number`.
  All three resolve to one normalized shape: `{host, repoOwner, repoName, number, url}`.
  A command/result that doesn't parse is silently skipped (not every `gh api` call
  creates a PR).

**KTD4 — Status-by-identity widens the existing poll grid instead of building a second
poller.** `docs/forge-providers.md` is explicit: GitHub PR polling owns one account-wide
GraphQL budget, and a new per-target request must not bypass the shared batch. Research
found that batch poller (`packages/server/src/services/github-service.ts:1050-1151`,
`GitHubPollTarget`) is keyed by `{cwd, headRef}` and resolves `owner`/`name` from the
cwd's git remote. Rather than add a second, uncoordinated poll loop for ledger PRs, widen
`GitHubPollTarget` (and the Gitea equivalent) to accept an **explicit identity** variant —
`{host, repoOwner, repoName, number}` supplied directly, with `cwd` kept only as the
authenticated context to run `gh`/`tea` from (the PR's own creating agent's `cwd`, which
is guaranteed authenticated for that host) — batched onto the same shared GraphQL query
and the same rate-limit gate as checkout-anchored targets. `getPullRequest({cwd, number})`
(`forge-service.ts:439`) has no `--repo` flag and trusts `cwd`'s own remote; this plan
adds the identity-explicit method research flagged as the gap
(`getPullRequestStatusByIdentity`), implemented by extending the existing adapters rather
than inventing a parallel status path.

**KTD5 — Ledger retain/release drives poll lifecycle, matching R6.** The ledger owns the
set of "still open" tracked PRs. Adding a PR to the ledger as `open` retains a poll
target (background sweep picks it up); a status read that comes back merged/closed
releases the target, same as the existing frozen-checks cache already does for
checkout-anchored merged/closed PRs (`github-service.ts:1142-1144`). No new "is the tab
visible" concept reaches the server — the client's 60s foreground refetch reads the
server's cache; it never changes what the server polls.

**KTD6 — Detail-pane repoint: widen the existing `pull_request` panel target, don't add a
second pane type.** The checks/timeline rendering (`PullRequestPane`,
`packages/app/src/git/pull-request-panel/pane.tsx`, and `packages/app/src/panels/
pull-request/`) is already shape-agnostic over `PrPaneData` — it doesn't care whether the
data came from the checkout-branch RPC or an identity RPC (confirmed by research: `data.ts`
mapping, `pane.tsx`, `timeline.ts`, `checks-summary.ts`, `activity-state.ts` need no
change). Add an explicit-identity variant to `usePrPaneData`
(`packages/app/src/git/pull-request-panel/use-data.ts`) alongside the existing
cwd-derived path, and widen the `pull_request` panel's target (`panels/panel-registry.ts`
target union, consumed by `pull-request-panel.tsx`) to carry an optional explicit
identity. On compact layouts (no separate pane to open), tapping a PRs-tab row drills into
an in-place detail view inside the same tab (list ⇄ detail, back button) since the
Explorer dock is the only surface available. On wide/desktop layouts, tapping a row opens
the existing three-way-routed `pull_request` panel (Main / On the side / Explorer
sidebar) with the explicit identity, reusing `openPreferredTarget`
(`docs/explorer-sidebar.md`). A forge without identity-status support (KTD4 scopes this
to GitHub + Gitea-family) falls back to `Linking.openURL(row.url)` per R4.

---

## Output Structure

```
packages/server/src/server/pull-request-ledger/
  pull-request-ledger-store.ts        # file-backed rows, mirrors compaction-ledger-store.ts
  pull-request-ledger-store.test.ts
  pull-request-ledger-detect.ts       # pure: ToolCallDetail -> normalized PR identity | null
  pull-request-ledger-detect.test.ts
  pull-request-ledger-service.ts      # timeline observer, backfill, descendant-tree list()
  pull-request-ledger-service.test.ts

packages/protocol/src/pull-requests/
  rpc-schemas.ts                      # workspace.pullRequests.list, checkout.forge.get_pull_request_status
  rpc-schemas.test.ts

packages/app/src/panels/pull-requests-tab/
  index.tsx                           # list + master-detail drill-in for compact layouts
  use-pull-requests.ts                # RPC hook, 60s refetch while visible
  row.tsx
  index.test.ts
```

---

## Implementation Units

### U1. Protocol: ledger RPCs, identity-status RPC, feature flag

**Goal**: Wire the two new dotted RPCs and the `pullRequestLedger` feature flag, following
`docs/rpc-namespacing.md` and the compaction-ledger precedent exactly.

**Requirements**: R1, R2, R6, R7

**Dependencies**: none

**Files**:

- `packages/protocol/src/pull-requests/rpc-schemas.ts` (new)
- `packages/protocol/src/pull-requests/rpc-schemas.test.ts` (new)
- `packages/protocol/src/messages.ts` (import + register in request/response unions, near
  the `compaction.episodes` registration at `:80-85`, `:4000`, `:7864`)
- `packages/protocol/src/messages.ts` (add `pullRequestLedger: z.boolean().optional()` to
  the server_info features schema, beside `compactionLedger` at `:4495-4497`)

**Approach**:

- `workspace.pullRequests.list.request` takes `{workspaceId, requestId}`. `.response`
  payload is `{workspaceId, pullRequests: PullRequestLedgerEntry[], requestId}` where
  each entry carries `{id, host, repoOwner, repoName, number, url, forge, title,
creatingAgentId, creatingAgentTitle, detectedAtMs, status}` and `status` is the same
  shape `CheckoutPrStatusSchema` already exposes (open/merged/closed, checks, review
  decision) so the app can render a row without a second round trip.
- `checkout.forge.get_pull_request_status.request` takes `{cwd, host, repoOwner,
repoName, number, requestId}` (`cwd` is the creating agent's cwd, for auth context per
  KTD4, not the identity). `.response` payload mirrors `CheckoutPrStatusPayloadSchema`'s
  `status` shape, so the app-side mapper (`data.ts`) needs no new branch.
- All new fields `.optional()`; no changes to existing schemas. Wire schemas stay pure
  (no `.transform()`/`.catch()`/`.preprocess()`), consistent with `docs/
protocol-compatibility.md`.

**Patterns to follow**: `packages/protocol/src/compaction/rpc-schemas.ts` end to end
(request/response pair shape, `payload` wrapper, `requestId` correlation).

**Test scenarios**:

- `workspace.pullRequests.list.request`/`.response` round-trip through `z.parse` with a
  minimal and a fully-populated entry.
- `checkout.forge.get_pull_request_status.request`/`.response` round-trip.
- An old-shape `server_info` (no `pullRequestLedger` key) still parses — regression guard
  for the optional-field rule.

**Verification**: `npx vitest run packages/protocol/src/pull-requests/rpc-schemas.test.ts`
passes; `npm run typecheck` clean for `packages/protocol`.

---

### U2. Server: PR-creation detection (pure functions)

**Goal**: Given a `ToolCallDetail`, return the normalized PR identity it created, or
`null`.

**Requirements**: R2 (KTD3)

**Dependencies**: none

**Files**:

- `packages/server/src/server/pull-request-ledger/pull-request-ledger-detect.ts` (new)
- `packages/server/src/server/pull-request-ledger/pull-request-ledger-detect.test.ts` (new)

**Approach**: Three small matchers behind one `detectPullRequestCreation(detail: ToolCallDetail): DetectedPullRequest | null`:

1. `shell` detail: command matches `/^\s*gh\s+pr\s+create\b/`, `/^\s*tea\s+pulls?\s+create\b/` — extract the first URL-shaped token from `output` matching the host's PR path grammar (`/pull/`, `/pulls/`) per `packages/app/src/git/pr-hint.ts`'s existing regex as a reference, parse host/owner/repo/number from it.
2. `shell` detail: command matches `gh api` with a path ending in `/pulls` and `-X POST`/`--method POST` (gh defaults to POST when a body is piped, so also treat a bare `gh api .*/pulls` with no explicit GET as a candidate) — parse `output` as JSON, read `html_url`/`number`.
3. `unknown` detail: tool name (on `metadata` or the detail's own name field — confirm exact field in `ToolCallBase`/`ToolCallDetail` during implementation) is `create_pull_request` or ends in `.create_pull_request` — parse `output` as JSON, read `html_url`/`number` (GitHub MCP) or the Gitea-equivalent MCP shape if one is in use.

**Execution note**: Implement test-first — these are pure functions with fully specified
inputs/outputs; write the fixture commands/outputs first, then the matcher.

**Patterns to follow**: `pr-hint.ts`'s `parsePullRequestNumber` regex approach.

**Test scenarios**:

- `gh pr create` shell output containing `https://github.com/acme/widgets/pull/42` ->
  `{host: "github.com", repoOwner: "acme", repoName: "widgets", number: 42, url: ...}`.
- `tea pulls create` output containing `https://git.example.com/acme/widgets/pulls/7` ->
  parses the Gitea-style `/pulls/` path.
- `gh api repos/acme/widgets/pulls -X POST` with a JSON body containing `html_url` ->
  parses correctly; the same command with a GET (`gh api repos/acme/widgets/pulls`, no
  POST) -> `null` (listing, not creating).
- `unknown` detail with tool name `create_pull_request` and a JSON output containing
  `html_url`/`number` -> parses.
- A `shell` detail running `gh pr list` -> `null`.
- A `shell` detail running `gh pr create` that failed (non-zero exit, no URL in output) ->
  `null`.
- Malformed/truncated JSON in an `unknown` detail's output -> `null`, no throw.

**Verification**: `npx vitest run packages/server/src/server/pull-request-ledger/pull-request-ledger-detect.test.ts`.

---

### U3. Server: ledger store (durable, bounded)

**Goal**: File-backed store for detected PR-creation rows, mirroring
`compaction-ledger-store.ts` exactly for persistence mechanics (atomic write, corrupt-file
quarantine, retention/row-cap eviction).

**Requirements**: R2, R6

**Dependencies**: U2 (row shape consumes `DetectedPullRequest`)

**Files**:

- `packages/server/src/server/pull-request-ledger/pull-request-ledger-store.ts` (new)
- `packages/server/src/server/pull-request-ledger/pull-request-ledger-store.test.ts` (new)

**Approach**: `PullRequestLedgerRow = {id, agentId, agentTitle, host, repoOwner,
repoName, number, url, forge, detectedAtMs, status: "open"|"merged"|"closed", lastStatusCheckedAtMs}`.
`id` is `` `${host}/${repoOwner}/${repoName}#${number}` `` (identity-keyed, not
agent+time-keyed like compaction episodes — the same PR detected twice, e.g. by a retry,
upserts the same row rather than duplicating). Store state at
`$PASEO_HOME/pull-requests/state.json`. Limits: 2,000 rows / 180 days (Assumptions). No
backfill marker needed on the store itself — KTD2's backfill is boot-scan-driven by the
service, not file-log-driven, so there's nothing to mark "done" against; the service
tracks which resident agents it has already scanned in memory for the life of the
process.

**Patterns to follow**: `compaction-ledger-store.ts` in full — `writeFileAtomic`,
`isMissingFile`, corrupt-file aside-and-start-empty, `maybeFlush`/`flush` debounce,
`prune(nowMs)`.

**Test scenarios**:

- `upsertRow` with a new identity adds a row; with an existing identity replaces it
  (status transition open -> merged persists).
- Row-cap eviction drops the oldest `detectedAtMs` row when at capacity.
- `prune` drops rows past 180 days.
- A corrupt `state.json` is set aside as `state.json.corrupt-<ms>` and the store starts
  empty rather than throwing.
- A `state.json` that cannot be read (permissions) leaves `writable=false` and a
  subsequent write is a no-op rather than destroying unreadable-but-present data.
- Fields added after this release are optional on read (schema evolution smoke test:
  parse a row object missing a hypothetical future field).

**Verification**: `npx vitest run packages/server/src/server/pull-request-ledger/pull-request-ledger-store.test.ts`.

---

### U4. Server: ledger service — live detection, backfill, descendant resolution, list()

**Goal**: Wire detection into the live timeline, run the boot-time backfill scan, and
answer `list(workspaceId)` by resolving the full descendant tree.

**Requirements**: R2 (KTD1, KTD2)

**Dependencies**: U2, U3

**Files**:

- `packages/server/src/server/pull-request-ledger/pull-request-ledger-service.ts` (new)
- `packages/server/src/server/pull-request-ledger/pull-request-ledger-service.test.ts` (new)
- `packages/server/src/server/agent/agent-manager.ts` (add `subscribeTimelineRecorded(listener: (agentId: string, row: AgentTimelineRow) => void): () => void`, following the `subscribeOperatorSignals`/`subscribeTokenBurn` pattern at `:2230-2242`; call listeners from `recordTimeline` at `:7144-7157`)
- `packages/server/src/server/bootstrap.ts` (construct `PullRequestLedgerService`
  alongside `createCompactionLedgerService` at `:984-1010`/`:3571-3594`; call its
  boot-scan after `agentManager` has registered its already-resident agents)

**Technical design** (directional):

```
PullRequestLedgerService.start(agentManager):
  unsubscribe = agentManager.subscribeTimelineRecorded((agentId, row) => {
    if row.item.type !== "tool_call" or not completed: return
    detected = detectPullRequestCreation(row.item.detail)
    if detected: store.upsertRow(buildRow(agentId, detected, now()))
  })

  // KTD2 boot backfill: resident agents already hold their replayed timeline in memory.
  for agentId in agentManager.listResidentAgentIds():
    for row in agentManager.getTimelineRows(agentId):   # exact accessor TBD at implementation
      detected = detectPullRequestCreation(row.item.detail)
      if detected: store.upsertRow(buildRow(agentId, detected, row.timestamp))

list(workspaceId):
  roots = agentManager.listAgents().filter(a => a.workspaceId == workspaceId and !a.parentAgentId)
  descendantIds = roots + transitive closure via labels["paseo.parent-agent-id"],
                  over ALL agent records including archived (agent-storage registry.list()),
                  NOT filtered to workspaceId (children may live in other workspaces)
  rows = store.listRows().filter(r => descendantIds.has(r.agentId))
  dedupe by identity id against the workspace's own checkout-branch PR (fetched via the
    existing getCurrentPullRequestStatus path, same identity key host/owner/repo/number)
  return rows, newest first
```

**Approach**: The exact accessor for "resident agent's current in-memory timeline rows"
and "every agent record including archived" needs locating at implementation time —
research points at `AgentManager`'s internal `this.agents` map plus whatever the existing
timeline-replay RPC handler reads, and `AgentStorage.registry.list()`
(`agent-storage.ts:157-160`) respectively (the same accessor `cascadeArchiveChildren`
uses at `agent-manager.ts:3622-3661`, minus its `!archivedAt` filter). Reuse rather than
re-derive.

**Patterns to follow**: `compaction-ledger-service.ts`'s `start()`/`stop()`/
`reconcileAfterLoad()` shape; `cascadeArchiveChildren`'s descendant-walk predicate.

**Test scenarios**:

- A `tool_call` completed row with a detectable `gh pr create` shell detail upserts a
  store row tagged with that row's `agentId`.
- A `tool_call` row with no detectable PR creation is a no-op.
- Boot scan over two resident agents, one with a historical PR-creating tool call already
  in its in-memory timeline, produces a row for that agent without needing a new tool
  call.
- `list(workspaceId)` for a workspace whose root agent has a child in a _different_
  workspace (cross-workspace subagent, per `docs/agent-lifecycle.md`) still includes PRs
  the child created.
- `list(workspaceId)` includes PRs from an _archived_ descendant.
- `list(workspaceId)` dedupes a row whose identity matches the checkout branch's own PR —
  returns it once, not twice.
- `list(workspaceId)` for a workspace with no agents returns `[]`, not an error.

**Verification**: `npx vitest run packages/server/src/server/pull-request-ledger/pull-request-ledger-service.test.ts`.

---

### U5. Server: status-by-identity + poll-grid widening

**Goal**: Add `ForgeService.getPullRequestStatusByIdentity` and widen the GitHub (and
Gitea-family) batch poller to retain/release explicit-identity targets, driven by the
ledger's open/closed transitions.

**Requirements**: R3, R6 (KTD4, KTD5)

**Dependencies**: U3 (ledger rows are the retain/release source)

**Files**:

- `packages/server/src/services/forge-service.ts` (widen interface: add
  `getPullRequestStatusByIdentity({cwd, host, repoOwner, repoName, number}):
Promise<CurrentPullRequestStatus>`, and `retainTrackedPullRequest`/
  `releaseTrackedPullRequest` alongside whatever the existing checkout-anchored
  retain/callback method is named — locate it before adding a parallel one)
- `packages/server/src/services/github-service.ts` (widen `GitHubPollTarget` to a
  discriminated union of `{kind: "checkout", cwd, headRef, ...}` and `{kind: "identity",
host, repoOwner, repoName, number, cwd}`, both batched through the existing
  `buildBatchPullRequestStatusQuery`/`buildBatchPullRequestChecksQuery`
  (`:759-856`) and the existing rate-limit gate (`pollPausedUntilByHost`, `:1149`))
- `packages/server/src/services/gitea-service.ts` (equivalent widening, scoped to
  whatever polling that adapter already does for checkout-anchored PRs — if it has no
  equivalent batch poller, implement a per-target interval poll bounded by the same 5-
  minute cadence rather than inventing batching Gitea doesn't need yet)
- `packages/server/src/server/pull-request-ledger/pull-request-ledger-service.ts`
  (on a row transitioning to `open`, call `retainTrackedPullRequest`; on a row's refreshed
  status coming back `merged`/`closed`, call `releaseTrackedPullRequest` and persist the
  terminal status — mirrors the existing frozen-checks behavior in `github-service.ts:1142-1144`)

**Approach**: `getPullRequestStatusByIdentity` runs `gh pr view <number> --repo
<owner>/<name>` (or the GraphQL batch path) instead of today's bare `gh pr view <number>`
(`github-service.ts` near `2065-2087`), using the creating agent's `cwd` only to select
which `gh`/`tea` auth context to run from. Batch distribution
(`GitHubBatchDistribution`, `:1092-1095`) needs no new branch — identity targets supply
`owner`/`name` directly instead of going through `resolveRepoSlugCached(cwd)`.

**Patterns to follow**: The existing `GitHubPollTarget` retain-count/callback lifecycle
end to end; the frozen-checks cache for terminal PRs (`frozenPullRequestChecksCache`,
`:1144`).

**Test scenarios**:

- An identity target and a checkout-anchored target for the same host are batched into
  one GraphQL query (assert the built query string contains both aliases).
- Retaining the same identity target twice (two interested callers) shares one poll slot
  (`retainCount` increments, only one query fires).
- A status read returning `merged` releases the target and the next sweep tick does not
  re-poll it.
- Rate-limit pause (`pollPausedUntilByHost`) defers an identity target's next poll the
  same way it already defers checkout-anchored targets.
- `getPullRequestStatusByIdentity` for a repo the `cwd`'s token can't access surfaces the
  forge's own error (no silent empty state).

**Verification**: `npx vitest run packages/server/src/services/github-service.test.ts`
(existing file, extended) and the new/extended gitea-service test file.

---

### U6. Server: session RPC handlers + bootstrap wiring

**Goal**: Answer the two new RPCs over the session, gated by `pullRequestLedger`.

**Requirements**: R1, R7

**Dependencies**: U1, U4, U5

**Files**:

- `packages/server/src/server/session/pull-requests/pull-requests-session.ts` (new,
  mirrors `session/compaction/compaction-session.ts`)
- `packages/server/src/server/session.ts` (dispatch cases, mirrors `:2368-2371`)
- `packages/server/src/server/authorization/operation-permissions.ts` (permission
  entries, mirrors `:46-47,283-284`)
- `packages/server/src/server/websocket-server.ts` (thread `pullRequestLedgerService`
  through `SessionOptions` same as `compactionLedger` at `:183-184,641,702,1580`; set
  `features.pullRequestLedger: true` only when the service exists, mirroring `:1821-1822`)
- `packages/server/src/server/bootstrap.ts` (construct + start the service; call `stop()`
  on shutdown, mirroring the compaction ledger's `:3571-3594`, `:3910`, `:4205`)

**Approach**: `workspace.pullRequests.list` calls `pullRequestLedgerService.list(workspaceId)`.
`checkout.forge.get_pull_request_status` resolves the forge via the same
`resolveForgeService(cwd)`/`requireForgeService` the timeline/check-details handlers
already use (`checkout-session.ts:170-188`), then calls
`getPullRequestStatusByIdentity`.

**Patterns to follow**: `compaction-session.ts` end to end for the list handler shape.

**Test scenarios**:

- `workspace.pullRequests.list.request` for a known workspace returns the expected rows
  (integration test against a fake `PullRequestLedgerService`).
- The RPC is rejected/unavailable when `pullRequestLedgerService` is not constructed
  (old-daemon-shape simulation) — confirms the feature flag's absence matches actual
  unavailability.
- `checkout.forge.get_pull_request_status.request` for an unsupported forge returns a
  typed error the app can distinguish from "PR not found."

**Verification**: targeted vitest run on the new session test file; `npm run typecheck`
for `packages/server`.

---

### U7. App: repoint the PR detail pane at an explicit identity

**Goal**: Let the existing checks/timeline pane render for an arbitrary PR identity, not
only the checkout's own branch PR.

**Requirements**: R4 (KTD6)

**Dependencies**: U1, U6

**Files**:

- `packages/app/src/git/pull-request-panel/use-data.ts` (add an identity-driven path
  alongside the cwd-derived one; both converge on the same `PrPaneData` shape so `pane.tsx`
  etc. need no change, per research)
- `packages/app/src/git/pull-request-panel/query-keys.ts` (identity-keyed cache key
  variant, not just `[serverId, cwd]`)
- `packages/client/src/daemon-client.ts` (new method
  `checkoutForgeGetPullRequestStatus`, mirrors `pullRequestTimeline` at `:4448-4463`)
- `packages/app/src/panels/panel-registry.ts` (widen the `pull_request` panel target to
  carry an optional explicit identity alongside the workspace-derived default)
- `packages/app/src/panels/pull-request-panel.tsx` (read the optional identity off
  `target`, pass to the widened `usePullRequestData`)

**Approach**: `usePrPaneData({serverId, cwd, identity?})` — when `identity` is supplied,
skip `extractPrRepoIdentity` (today's only source, `use-data.ts:44-49`) and call
`checkoutForgeGetPullRequestStatus` directly with the explicit identity, feeding the same
downstream pipeline (`use-pipeline.ts`) the checkout path already uses.

**Patterns to follow**: The existing cwd-derived path in `use-data.ts:198-279`, extended
rather than duplicated — one hook, one extra optional parameter, not a second hook.

**Test scenarios**:

- `usePrPaneData` with an explicit identity and no `cwd`-derived status still produces
  the same `PrPaneData` shape the checkout path produces (snapshot-equivalence test).
- Query key for two different explicit identities under the same `serverId`/`cwd` don't
  collide.
- A forge not in the identity-support set (per KTD6 scope) is a clear signal the caller
  checks before calling this hook, not a silent empty state — verify the hook surfaces
  "unsupported" distinctly from "loading" and "not found."

**Verification**: `npx vitest run packages/app/src/git/pull-request-panel/use-data.test.ts`
(extended) and `packages/app/src/panels/pull-request/index.test.ts` (extended).

---

### U8. App: PRs tab — list, row, master-detail drill-in, i18n

**Goal**: Replace the "PR #N" tab with "PRs" in the compact Explorer sidebar; render the
list with live status; wire tap-to-detail per KTD6's compact-vs-wide split; ship every
string in every locale.

**Requirements**: R1, R2, R3, R4, R5, R6, R8

**Dependencies**: U6, U7

**Files**:

- `packages/app/src/stores/explorer-tab-memory.ts` (`ExplorerTab = "changes" | "files" |
"pr" | "prs"` — keep `"pr"` in the union and in `isExplorerTab` so an old persisted
  value still parses; `coerceExplorerTabForCheckout`/`resolveExplorerTabForCheckout` map a
  stored `"pr"` to `"prs"` going forward)
- `packages/app/src/components/compact-explorer-sidebar.tsx` (replace the `showPrTab`
  availability check — the tab is unconditional on git workspaces per R1 — and the
  `PrTabContent`/`PullRequestContent` render with the new list component; keep the old
  `prPane`/`formatPrTabLabel` usage removed, since there's no single-PR tab anymore)
- `packages/app/src/panels/pull-requests-tab/index.tsx` (new: list view; renders rows from
  `workspace.pullRequests.list`; on a row tap, compact layouts push an in-place detail
  sub-view using U7's identity-driven pane content, desktop/wide layouts call
  `openPreferredTarget` for the `pull_request` panel with the explicit identity)
- `packages/app/src/panels/pull-requests-tab/use-pull-requests.ts` (new: React Query hook,
  `refetchInterval: 60_000` while the tab is the active/visible one, matching R6's
  foreground cadence; a background/background-sweep cadence is a server concern per
  KTD5, not duplicated here)
- `packages/app/src/panels/pull-requests-tab/row.tsx` (new: forge icon, number, title,
  checks summary, review decision, merged/closed/open badge — reuse
  `PullRequestTabIcon`/check-presentation primitives already used by the single-PR tab)
- `packages/app/src/panels/use-host-feature.ts` (or wherever `useHostFeature` lives per
  the compaction ledger precedent) — gate tab availability on
  `useHostFeature(serverId, "pullRequestLedger")`; when absent, render the **old**
  single-PR "PR #N" tab exactly as today (R7's old-daemon path), not an empty/broken tab
- i18n: add `workspace.tabs.explorerSidebar.prs` (tab label) and a `panels.pullRequests`
  namespace (list empty state, error state, row accessibility labels) to every file under
  `packages/app/src/i18n/resources/` (`ar, en, es, fr, ja, ko, pt-BR, ru, zh-CN`)

**Approach**: `availableTabs` in `compact-explorer-sidebar.tsx` becomes: on a new-enough
daemon (`pullRequestLedger` feature present), `isGit ? ["changes", "files", "prs"] :
["files"]` — `"prs"` always included for git workspaces, no `showPrTab`-style
availability gate (R1). On an old daemon, fall back to today's exact behavior
(`["changes", "files"]` plus `"pr"` only when a branch PR exists) — this is the R7
old-daemon path, implemented as a branch at the top of `ExplorerSidebarContent` rather
than threading a flag through every tab computation.

**Technical design** (directional, compact-layout drill-in):

```
PullRequestsTabContent:
  state: {view: "list"} | {view: "detail", identity: PullRequestIdentity}
  list view: rows from use-pull-requests; onRowPress -> setState({view: "detail", identity})
  detail view: <PullRequestContent ... identity={identity} /> (U7) + back button -> setState({view: "list"})
```

**Test scenarios**:

- Old persisted `explorerTab: "pr"` resolves to `"prs"` on the new build.
- A git workspace with zero PRs renders the tab (R1: unconditional) with an empty state,
  not a hidden tab.
- A git workspace where the RPC call fails renders a distinct error state, not the empty
  state (explicit coding-standards requirement: "An error fetching the list must read as
  an error, not as 'No PRs yet'").
- Row list includes a PR from a descendant subagent in a different cwd, and the
  checkout's own branch PR appears exactly once even though it's also in the ledger.
- Tapping a row on a compact layout shows the detail view with a working back button;
  on wide layout, tapping opens the `pull_request` panel via the user's routing
  preference.
- A forge outside the identity-support set falls back to opening the PR URL on tap
  (`Linking.openURL`), not a broken/empty detail view.
- `useHostFeature(serverId, "pullRequestLedger") === false` renders the old "PR #N" tab
  unchanged — golden-path regression test for R7.
- Every new locale file has the new keys (a test that diffs key sets across
  `i18n/resources/*.ts` against `en.ts`, extending whatever existing locale-completeness
  check the repo already runs, if any — if none exists, add one scoped to the new keys).

**Verification**: `npx vitest run packages/app/src/panels/pull-requests-tab/index.test.ts`;
`npx vitest run packages/app/src/components/compact-explorer-sidebar.test.tsx` if it
exists (extend it) else add one; manual check in the dev app per the project's UI-change
rule (start `npm run dev:app`, open a git workspace, confirm the tab, a PR row, and the
detail drill-in).

---

## Scope Boundaries

**In scope**: everything in R1-R8 and the eight units above.

**Deferred to follow-up work**:

- True historical backfill by parsing each provider's native transcript format directly
  (Claude Code/Codex/Copilot/OpenCode/Pi each have a different on-disk shape). KTD2's
  boot-scan-of-resident-agents is the shipped substitute; a `closed` agent not reopened
  since this feature shipped won't show its PRs until it's next opened.
- Non-GitHub/non-Gitea-family forges repointing the detail pane by identity (KTD6) — they
  fall back to the PR URL.
- A dedicated sidebar chip or badge count for open PRs (Tyler's decision #3: tab only).
- Detecting PR creation through forges' own web UI (a human clicking "Create PR" on
  github.com) — detection is tool-call-based only; this is inherent to the ledger's
  design, not a gap to close later.

**Outside this feature's identity**: PR _merge_/_close_ actions from this tab (the tab is
read-only status + navigation, per Tyler's ask — "so I don't have to ask the agent about
them").

## System-Wide Impact

- **Server**: one new always-on timeline observer (cheap — a `switch` on tool-call detail
  type per recorded row) and one new bounded poll-grid widening. No new always-running
  timers beyond the existing compaction-ledger-style sweep pattern.
- **Forge rate limits**: every tracked open PR becomes a retained poll target. Bounded by
  KTD4/KTD5 reusing the shared batch and rate-limit gate — this plan does not add a
  second, uncoordinated GitHub GraphQL consumer.
- **App**: new RPC surface gated behind a feature flag; no behavior change for a client
  talking to a pre-feature daemon.
- **Docs**: `docs/explorer-sidebar.md` (tab description, R1/R5), new
  `docs/pull-request-ledger.md` (ledger shape, detection sources, the KTD2 boot-scan
  caveat, poll-grid widening — mirroring `docs/insights.md`'s treatment of the compaction
  ledger), and a new row in the root `CLAUDE.md` docs table pointing at it.

## Verification Contract

- `npm run typecheck` and `npm run lint` clean after each unit.
- Every unit's listed test file passes via `npx vitest run <file> --bail=1`.
- `npm run format` run before each commit.
- No full-suite run (repo rule) — rely on targeted runs plus CI for the broad gate.

## Definition of Done

- All 8 units implemented, typechecked, linted, and formatted.
- Old daemon / new app: sidebar shows today's exact "PR #N" (or no PR tab) behavior —
  verified by the U8 feature-flag-absent test.
- New daemon / old app: old app doesn't know about `workspace.pullRequests.list` or the
  new feature flag key; it keeps calling `checkout_pr_status_request` and rendering the
  old single-PR tab — no schema change breaks this (R7).
- `docs/explorer-sidebar.md` updated; `docs/pull-request-ledger.md` created; root
  `CLAUDE.md` docs table has a new row for it.
- Locally committed via `ce-commit` per unit or logical group, not pushed (per the
  invocation's instructions — the leader ships).
