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

- A `shell` detail whose command matches `gh pr create` or `tea pulls create` — the PR URL is
  parsed out of the command's stdout.
- A `shell` detail running `gh api .../pulls` with a POST indicator (`-X POST`, `-f`, `-F`,
  `--input`) — the JSON response body is parsed for `html_url`/`number`. A bare GET to the same
  path is not a creation.
- An `unknown` detail (an MCP tool Paseo doesn't have a specific mapping for, e.g. GitHub MCP's
  `create_pull_request`) whose tool name ends in `create_pull_request` — its JSON result is
  parsed the same way.

All three resolve to one shape: `{host, repoOwner, repoName, number, url, forge}`. `forge` is
inferred from the URL path grammar (`/pull/N` is GitHub, `/pulls/N` is the Gitea family), not
asserted — a command or result that doesn't parse returns `null` rather than throwing, since not
every `gh`/`tea`/MCP call creates a PR.

## Backfill

A true backfill — reading every provider's native transcript format directly — is out of scope:
Claude Code, Codex, Copilot, OpenCode, and Pi each have a different on-disk shape with no shared
parser. Instead, `PullRequestLedgerService.backfillResidentAgents()` runs once at boot and scans
the timeline rows already held in memory for every currently-resident agent — idle agents stay
resident indefinitely, so this catches every leader session that has been running since before
this feature shipped, through the same `detectPullRequestCreation` the live path uses.

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
(a retry, or a later status transition) upserts the same row rather than duplicating it. Each row
carries the creating agent's `cwd`, not only its id and title: a status fetch by identity needs an
authenticated CLI context to run from, and the creating agent's own cwd is guaranteed authenticated
for that PR's host.

`PullRequestLedgerService.list(workspaceId)` resolves every agent currently recorded against that
workspace, then walks `parentAgentId` labels to the full descendant tree — including archived
descendants and descendants that live in a different workspace (a leader's children routinely open
PRs from their own worktrees). It does not dedupe against the workspace checkout's own branch PR;
that PR is just another row the moment anyone runs `gh pr create` for it, so the common case needs
no special-casing. A PR that exists only because a human created it through a forge's web UI, with
no tool call behind it, is the one case nothing here will ever see — detection is tool-call-based by
design, not a gap to close later.

## Status by identity

`ForgeService.getPullRequestStatusByIdentity` (optional on the interface) fetches a PR's live
status by explicit `{repoOwner, repoName, number}` instead of deriving it from the checkout's
current branch, the way `getCurrentPullRequestStatus` already does. The GitHub adapter implements
it with `gh pr view <number> --repo <owner>/<name>`, reusing the existing
`toCurrentPullRequestStatus` parser — a plain per-call fetch, not folded into the batched
checkout-branch poll grid (`GitHubPollTarget` in `github-service.ts`) that already serves the
single-PR tab's live badge for every connected client. Gitea-family identity status is not
implemented; a row on an unsupported forge falls back to opening the PR URL instead of showing a
broken detail view.

**Deferred, not forgotten:** coordinating ledger PRs through the shared GitHub poll grid
(`docs/forge-providers.md`'s "one account-wide GraphQL budget") so background status refresh for
every tracked open PR shares the existing rate-limit gate, the way the plan originally scoped it.
Today each `checkout.forge.get_pull_request_status` call is independent, bounded only by how often
the app asks (60s per row while its detail is open or its row is on screen) — safe, but not yet
sharing the budget with the branch-PR poller.

## The RPCs

`workspace.pullRequests.list` / `checkout.forge.get_pull_request_status`
(`packages/protocol/src/pull-requests/rpc-schemas.ts`), gated on
`server_info.features.pullRequestLedger`. `list` is `workspace.read`, same tier as
`compaction.episodes.list`; it returns identity and detection metadata with `status: null` — a
row's live status is fetched per row via the identity RPC, the same way the old single-PR tab
always fetched its one PR's status separately from knowing it existed. `get_pull_request_status`
takes `cwd` only to pick an authenticated CLI context, never as the PR's identity.

## The app

The Explorer sidebar's "PRs" tab (`packages/app/src/panels/pull-requests-tab/`) replaces "PR #N"
unconditionally on git workspaces when the daemon serves `pullRequestLedger` — no "only when a
branch PR exists" gate, since the point is seeing PRs the agent doesn't have to be asked about.
`usePullRequests` lists rows (refetch every 60s while the tab is open); each row fetches its own
live status independently (`useRowPullRequestStatus`) so a long list doesn't pay for a timeline
fetch nobody opened. Tapping a row drills into the same `PullRequestPane` the old tab used, fed by
`usePrPaneDataByIdentity` — an additive sibling to the checkout-branch `usePrPaneData` that targets
an explicit identity instead, so the existing checks/timeline rendering needed no changes.

On a host without the feature, the sidebar falls back to exactly the old single-PR-tab behavior:
`usePullRequestPanelAvailability` only runs in that path, gated the same way the tab button is.

## Not done yet

- Gitea-family `getPullRequestStatusByIdentity`.
- Coordinating ledger PR status refresh through the shared GitHub poll grid instead of a plain
  per-call fetch.
- Reading a closed, not-yet-reopened agent's provider-native transcript directly, instead of
  relying on it being opened to backfill.
- Routing a detail-view open through the `pull_request` panel's three-way placement preference
  (Main panel / On the side / Explorer sidebar) on wide/desktop layouts. `ExplorerSidebarContent`
  renders identically for compact and native-wide docks today, so tapping a row always drills in
  place inside the Explorer tab regardless of layout width.
