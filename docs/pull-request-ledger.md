# Pull request ledger

Which PRs a workspace's agent or any of its descendant subagents created, with live status.
Backs the Explorer sidebar's "PRs" tab ([docs/explorer-sidebar.md](explorer-sidebar.md)), which
replaces the single "PR #N" tab that only ever showed the checkout's own branch PR.

## Detection

There is no durable timeline store ([docs/agent-lifecycle.md](agent-lifecycle.md)): a timeline
lives in `AgentManager`'s in-memory store, rebuilt from each provider's native transcript when an
agent is loaded. Detection taps that live stream instead of a log file —
`AgentManager.subscribeTimelineRecorded` (mirrors `subscribeTokenBurn`) fires once per appended
timeline row, and `detectPullRequestCreation`
(`packages/server/src/server/pull-request-ledger/pull-request-ledger-detect.ts`) is a pure
function over a completed tool call's name and detail. It recognizes three shapes, all captured
verbatim in `ToolCallDetail` (`agent-sdk-types.ts`):

- A `shell` detail whose command matches `gh pr create` or `tea pulls create` at any command
  boundary (`;`, `&`/`&&`, `|`/`||`, `(`, a newline, or the start of the string), with any leading
  `VAR=value` assignments stripped and any `sh -c`/`bash -lc`/`zsh -c` wrapper unwrapped first —
  leaders' children always run `cd <worktree> && gh pr create ...`, not a bare command. The PR URL
  is parsed out of the command's stdout.
- A `shell` detail running a REST POST to the pulls _collection_ endpoint —
  `repos/{owner}/{repo}/pulls` (GitHub's `gh api`) or `api/v1/repos/{owner}/{repo}/pulls`
  (Gitea/Forgejo, via `tea api` or a raw `curl`) — with an explicit `-X POST`/`--method POST`, or
  an implicit POST body flag (`-f`, `-F`, `--raw-field`, `--input`, `-d`, `--data*`) when no other
  method is given. A sub-path (`.../pulls/42/comments`, `.../pulls/42/reviews`, `.../pulls/42` with
  `-X PATCH`) never matches — those edit or comment on an existing PR, they don't create one. The
  JSON response body is parsed for `html_url`/`number`; an `html_url` carrying a `#fragment`
  (a comment or review anchor, not the PR itself) is rejected.
- An `unknown` detail (an MCP tool Paseo doesn't have a specific mapping for, e.g. GitHub MCP's
  `create_pull_request`) whose tool name ends in `create_pull_request` — its JSON result is
  parsed the same way.

A non-zero `exitCode` on the tool call disqualifies all three shapes: a failed `gh pr create`
whose error output happens to mention an existing PR's URL (`"a pull request for X already
exists: <url>"`) is not a creation. All three resolve to one shape:
`{host, repoOwner, repoName, number, url, forge}`. `forge` is inferred from the URL path grammar
(`/pull/N` is GitHub, `/pulls/N` is the Gitea family), not asserted — a command or result that
doesn't parse returns `null` rather than throwing, since not every `gh`/`tea`/MCP call creates a
PR.

## Backfill

A true backfill — reading every provider's native transcript format directly — is out of scope:
Claude Code, Codex, Copilot, OpenCode, and Pi each have a different on-disk shape with no shared
parser. Instead, `PullRequestLedgerService.backfillResidentAgents()` runs once at boot and scans
the timeline rows already held in memory for every currently-resident agent — idle agents stay
resident indefinitely, so this catches every leader session that has been running since before
this feature shipped, through the same `detectPullRequestCreation` the live path uses. One
agent's timeline read failing (or throwing) doesn't stop the rest: each agent's scan runs in its
own try/catch, and backfill yields to the event loop between agents so a large resident set
never blocks it in one synchronous stretch. `detectedAtMs` is taken from the timeline row's own
timestamp, not wall-clock-at-detection-time — replaying history at boot doesn't re-date old PRs
against the ledger's retention window.

**Known gap.** A `closed` agent not resident at boot is not covered by the backfill. It is caught
the next time it is opened or prompted: `ensureAgentLoaded()` replays its provider history through
the same `recordTimeline` call the live observer subscribes to, so loading an old session is
itself a backfill for that one agent. There is no separate recovery path for a closed agent nobody
reopens.

## The ledger

`PullRequestLedgerStore` (`packages/server/src/server/pull-request-ledger/pull-request-ledger-store.ts`)
is one Zod-versioned state file under `$PASEO_HOME/pull-requests/state.json` — the same
persistence shape as the compaction ledger ([docs/insights.md](insights.md)): atomic debounced
writes, a corrupt file quarantined rather than overwritten, bounded by row count (2,000) and
retention (180 days). Rows are keyed by forge identity
(`` `${host}/${repoOwner}/${repoName}#${number}` ``), not by agent and time — a PR detected twice
(a retry, or a later status transition) upserts the same row rather than duplicating it, and the
_first_ observation's creator wins: a later tool call that happens to touch the same PR (a
follow-up `gh api` read, a retried create) never reassigns credit away from whoever actually
created it. Each row carries the creating agent's `cwd`, not only its id and title: a status fetch
by identity needs an authenticated CLI context to run from, and the creating agent's own cwd is
guaranteed authenticated for that PR's host.

`PullRequestLedgerService.list(workspaceId)` resolves every agent currently recorded against that
workspace, then walks `parentAgentId` labels to the full descendant tree — including archived
descendants and descendants that live in a different workspace (a leader's children routinely open
PRs from their own worktrees). `ensureTracked(identity, creator)` lets a PR be tracked outside tool-
call detection without ever overwriting an existing row's creator: `PullRequestsSession` calls it
for the workspace checkout's own current PR (read from the already-cached
`WorkspaceGitService.peekSnapshot` forge data, never a network call) when merging the list, and
again — with `getRow`-backed authorization, see "The RPCs" — the first time its identity-status RPC
is asked about a PR that isn't a tool-call detection yet. This closes the gap where the checkout's
own current-branch PR never reached the tab unless some tracked tool call happened to create it:
it is merged into every `list()` response (deduped by row id) the moment that workspace is listed,
and persists in the ledger from then on. A PR on a
_different_ branch that a human created through a forge's web UI, with no tool call and no current
checkout pointing at it, is the one case nothing here will ever see — detection is tool-call- and
checkout-based by design, not a gap to close later.

## Status by identity

`ForgeService.getPullRequestStatusByIdentity` (optional on the interface) fetches a PR's live
status by explicit `{repoOwner, repoName, number}` instead of deriving it from the checkout's
current branch, the way `getCurrentPullRequestStatus` already does. The GitHub adapter implements
it with `gh pr view <number> --repo <owner>/<name>`, reusing the existing
`toCurrentPullRequestStatus` parser — a plain per-call fetch, not folded into the batched
checkout-branch poll grid (`GitHubPollTarget` in `github-service.ts`) that already serves the
single-PR tab's live badge for every connected client. It does honor that grid's rate-limit pause:
when the shared GitHub poll for a host is paused after a secondary rate-limit response, a stale
cached value is returned if one exists, otherwise the call throws `ForgePollPausedError`
(`packages/server/src/services/forge-poll-paused-error.ts`), which `PullRequestsSession` maps to a
typed `{kind: "rate_limited"}` response instead of spawning `gh` into a host that's already backing
off. The Gitea adapter implements the same optional method with `tea api
repos/{owner}/{repo}/pulls/{number}`, reusing the existing list-item-to-status conversion and
best-effort checks enrichment `getCurrentPullRequestStatus` already uses for the current branch; a
404 that surfaces as a thrown command error resolves to `null` rather than throwing. **Known gap:**
`tea api` exits 0 on an HTTP error, so a real 404 arrives as an error body on stdout and never
reaches that branch. It fails the response schema instead, and the row shows `failed` with a Retry
where it should show `not_found`. See
[tea-api-exits-zero-on-http-errors](solutions/integration-issues/tea-api-exits-zero-on-http-errors.md).
A row on a forge with no `getPullRequestStatusByIdentity`
at all falls back to an explicit "Open in browser" action in the detail view instead of showing a
broken, never-resolving skeleton.

A `gh`/`tea` failure never propagates as a bare rejection: `PullRequestsSession.handleGetStatusRequest`
catches it and answers with a typed `{status: null, error: {kind, message}}` instead
(`kind` is `"invalid_request"`, `"not_found"`, `"unsupported_forge"`, `"rate_limited"`, or
`"failed"`) — the app surfaces this with a Retry that re-runs the fetch, not a silent timeout.

**Deferred, not forgotten:** coordinating ledger PRs through the shared GitHub poll grid
(`docs/forge-providers.md`'s "one account-wide GraphQL budget") so every tracked open PR's
background refresh shares that budget directly, rather than each identity query independently
consulting the pause gate. Today each `checkout.forge.get_pull_request_status` call is
independent, bounded only by how often the app asks (60s per row while its detail is open or its
row is on screen, `retry: false` since the fixed interval is already the retry) and stopped once a
PR reaches a terminal state (merged, or `state !== "open"`) or its forge turns out to be
unsupported — safe, but not yet sharing the budget with the branch-PR poller. There is also no
slower background cadence for an open PR's row once the tab itself is hidden: polling for that row
stops (`enabled` follows the tab's visibility), rather than continuing at a slower rate.

## The RPCs

`workspace.pull_requests.list` / `checkout.forge.get_pull_request_status`
(`packages/protocol/src/pull-requests/rpc-schemas.ts`), gated on
`server_info.features.pullRequestLedger` — the snake_case `pull_requests` segment follows
[docs/rpc-namespacing.md](rpc-namespacing.md)'s convention (unreleased at the time of the rename,
so no COMPAT shim). `list` is `workspace.read`, same tier as `compaction.episodes.list`; it returns
identity and detection metadata with no `status` field at all — a row's live status is fetched per
row via the identity RPC, the same way the old single-PR tab always fetched its one PR's status
separately from knowing it existed.

`get_pull_request_status` takes `cwd` only to pick an authenticated CLI context, never as the PR's
identity, and validates its own input before touching a forge: `repoOwner`/`repoName` must match a
plain slug segment (`/^[\w.-]+$/`) and `number` must be a positive integer, or the RPC answers
`invalid_request` without calling `resolveForge`. The requested `{host, repoOwner, repoName,
number}` must also be _authorized_ — either already a row in the ledger (`getRow`), or a match for
the requesting `cwd`'s own current checkout PR (`resolveForge` plus `peekSnapshot`, the same source
the list-merge above uses) — otherwise the RPC answers `not_found` rather than letting any
`workspace.read` client probe an arbitrary repo through whatever `gh`/`tea` context happens to be
authenticated at an arbitrary `cwd`. A successful status fetch is recorded back onto the ledger row
(`recordStatusCheck`) so the row's coarse `status` field reflects the last known state.

## The app

The Explorer sidebar's "PRs" tab (`packages/app/src/panels/pull-requests-tab/`) replaces "PR #N"
unconditionally on git workspaces when the daemon serves `pullRequestLedger` — no "only when a
branch PR exists" gate, since the point is seeing PRs the agent doesn't have to be asked about.
This holds on every layout: compact (phone/tablet overlay) and native-wide docks render
`PullRequestsTabContent` directly inside `ExplorerSidebarContent`
(`compact-explorer-sidebar.tsx`), and a split-pane desktop/web layout opens it as the
`pull_requests` panel kind (`packages/app/src/panels/pull-requests-tab-panel.tsx`,
`workspace-tabs/explorer-sidebar.ts`'s `VIEW_TARGETS.pr`) — the `pull_request` single-PR panel it
replaces stays registered (nothing else routes to it, but removing it outright is a separate
cleanup). The stored `"pr"` tab preference from before this feature shipped resolves against the
current host's actual availability at render time (`resolveExplorerSidebarTab` in
`compact-explorer-sidebar-tabs.ts`), not a blind migration: a host without the ledger keeps `"pr"`,
one with it resolves to `"prs"`.

`usePullRequests` lists rows: `retry: false`, refetching every 60s while the tab is open and not
at all while it's closed — there is no slower background cadence for a hidden tab (see "Not done
yet"). A failed refetch keeps the previously-loaded rows on screen with an inline error note
rather than blanking the list; only a bare failure with nothing cached yet shows the full error
state. Each row fetches its own live status independently (`useRowPullRequestStatus`) so a long
list doesn't pay for a timeline fetch nobody opened, using a function-form `refetchInterval` that
stops once that PR is merged or its state leaves `"open"`, or once its forge turns out to be
unsupported (`nextStatusRefetchInterval` in `use-forge-status-by-identity.ts`). A row or detail
view whose status is still loading, errored, unsupported, or genuinely not found renders the
neutral "unknown" state (no icon) rather than the closed PR's red glyph — `resolveRowState` in
`use-row-status.ts` only returns `"closed"` for a real, resolved non-open status. The identity used
for a row or detail view's status fetch falls back to the viewing workspace's own cwd
(`resolveStatusCwd`) when the creating agent's cwd is gone — an archived or restarted agent's row
still has a usable authenticated context to fetch from.

Tapping a row drills into the same `PullRequestPane` the old tab used, fed by
`usePrPaneDataByIdentity` — an additive sibling to the checkout-branch `usePrPaneData` that targets
an explicit identity instead, so the existing checks/timeline rendering needed no changes. It stops
fetching while the detail view isn't the active pane (`enabled: isOpen`), uses its own
identity-keyed timeline cache key (`prPaneTimelineByIdentityQueryKey`, distinct from the
checkout-branch hook's cwd-keyed one, so two different repos never collide because their
creating agents happen to share a cwd value), and surfaces the daemon's typed status-payload
error (`not_found`, `failed`, `rate_limited`, ...) instead of hanging on a skeleton forever. A PR
whose forge has no identity lookup shows an explicit "Open in browser" action rather than silently
redirecting there as a side effect. Every external link (`entry.url`, "Open in browser") goes
through `@/utils/open-external-url`, not `react-native`'s `Linking` directly.

On a host without the feature, the sidebar falls back to exactly the old single-PR-tab behavior:
`usePullRequestPanelAvailability` only runs in that path, gated the same way the tab button is.

## Not done yet

- Coordinating ledger PR status refresh through the shared GitHub poll grid instead of each
  identity query independently consulting the pause gate.
- Telling a Gitea 404 from a schema failure in `getPullRequestStatusByIdentity` (see "Status by
  identity").
- Reading a closed, not-yet-reopened agent's provider-native transcript directly, instead of
  relying on it being opened to backfill.
- A slower background poll cadence for an open PR's row once its tab goes hidden — polling stops
  today rather than continuing at a reduced rate.
