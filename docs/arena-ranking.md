# Arena-ranked model pick

Reorders a worker or reviewer's already-approved model pool by the LMArena
leaderboard, so the classifier picks the best-ranked candidate for the kind
of work instead of always the operator's first pool entry. Ranking never adds
a model to a pool. Leaders have their own, much stricter rule with its own
switch ([Leaders](#leaders)). Credit: "LMArena leaderboard
dataset (CC-BY-4.0)" — https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset.

## Data flow

1. **The daily job** (`server/arena-rankings.ts`) fetches the boards in the
   table below from the Hugging Face datasets-server JSON API, normalizes
   model names through a hand-kept alias table (`shared/arena-aliases.ts`,
   exact match only — an unmatched name is dropped and counted, never
   guessed), drops rows below the vote floor, and writes
   `$PASEO_HOME/arena-rankings.json` atomically. A failed refresh keeps the
   old file. For the leader boards it also keeps per-publish history and the
   top rows, matched or not ([Leaders](#leaders)).

   Several boards share one HF config — `text_style_control` alone backs
   five — so fetches are grouped by config and each is read once, not once
   per category, with requests spaced ~1.5s apart. A 429 or 5xx backs off
   5s/15s/45s, honoring `Retry-After` up to a 5-minute cap; past that, the
   page fails immediately rather than blocking the refresh. A board whose
   config errors after some of its rows were already collected keeps those
   rows instead of losing them; only boards with nothing collected land in
   `failedBoards`.

   A second poller (`startArenaRankingsPoller`'s `retryPoller`) retries just
   that refresh's `failedBoards` every ~45 minutes, up to 3 attempts, merging
   any recovery into the file instead of waiting for the next daily run — so
   a 429'd board can come back within the hour instead of sitting failed for
   a full day. Both pollers write the same file; they're serialized through a
   shared lock, and the retry additionally re-reads the file right before
   writing and drops its own merge if a daily refresh landed in the meantime
   (`retryFailedBoards`'s `"superseded"` result).

2. **The plugin cache** (`server/arena-ranking-cache.ts`) re-reads that file
   on an interval and feeds it to the classifier as `ClassifierWorld.arenaRanking`
   — undefined when the file is missing or older than `arena.maxAgeHours`.
   Staleness is resolved here, before the classifier ever sees the file: the
   pure ranking core treats "missing" and "stale" identically, as one fallback.
3. **`decideArenaPick`** (`server/arena-model-pick.ts`) is the pure core: given
   a role's pool, the kind of work, and the cached rankings, it decides a
   ranked pick or a fallback. `decideModel` (`server/classifier.ts`) calls it,
   then — unless `arena.shadow` is on — reorders the pool so the pick runs,
   ahead of an eligible explicit request too (see "Explicit requests" below).
   `classifyAgent` stays pure throughout: rankings arrive as world data, never
   a fetch.

The same cache feeds every consumer of `decideModel`: the `before("agent.create")`
hook, the `agent_model_policy` MCP tool (`server/classifier-tool.ts`), and the
`role-model-policy.explain` RPC the settings preview calls
(`server/role-policy-rpc-handlers.ts`). All three take `ClassifierWorld.arenaRanking`
from `index.server.ts`'s one `arenaRankingCache` — wiring a second instance, or
leaving one consumer's `world()` without it, silently drops that consumer back
to the `"no-file"` fallback, as the preview did until this was fixed.

## Policy shape

`agentModelPolicy` gains an optional `arena` key (`shared/role-policy-schema.ts`'s
`ArenaPolicySchema`). Absent entirely — the common case for an old config —
behaves exactly as before: zero extra computation, no `ranking` field on any
decision.

| Field             | Default                  | Meaning                                                                                     |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `enabled`         | `false`                  | Master switch.                                                                              |
| `shadow`          | `true`                   | Records the would-be pick without applying it (D6, "shadow first").                         |
| `roles`           | `["worker", "reviewer"]` | Policy role ids ranking applies to. The classifier refuses `leader` even if listed.         |
| `topTier`         | `[]`                     | Refs dropped from standard/mechanical candidates; win a hard pick only rarely.              |
| `topTierMarginCi` | `0`                      | Extra CI widths a top-tier pick must clear beyond a plain non-overlap win.                  |
| `maxAgeHours`     | `72`                     | How stale the rankings file may be before falling back.                                     |
| `leader`          | absent                   | The leader pick's own block ([Leaders](#leaders)). `enabled`/`shadow` above never reach it. |

## Boards, by kind of work

Each kind of work lists its boards in preference order. The classifier walks
them and uses the first with at least two usable, ranked candidates, never
mixing scores across boards.

| Kind            | Boards, in order                                                  |
| --------------- | ----------------------------------------------------------------- |
| coding          | `agent` overall, then `text_style_control` coding                 |
| frontend        | `webdev` webdev-react, then `webdev` overall, then `agent`        |
| research        | `text_style_control` expert, then hard_prompts                    |
| review          | `text_style_control` hard_prompts, then instruction_following     |
| writing         | `text_style_control` creative_writing, then instruction_following |
| ops             | `agent_bash_recovery_steps`, then `agent` overall                 |
| other / unknown | none — today's order                                              |

The kind comes from JEV's `work_kind` question (`docs/jev.md`, "Feature 2"),
asked whenever ranking could reorder the resolved class's pool. A reviewer
with no answer defaults to `review`. There is no keyword guessing.

Arena mostly ranks `max`/`xhigh` variants, so a row at a candidate's planned
effort is preferred; absent that, the nearest-effort row is used and marked a
**proxy**. A top-tier candidate on a proxy row must clear the margin bar by
one extra CI width, on top of `topTierMarginCi` — a proxy overstates what a
lower-effort run actually gets.

A ref sitting in a role's pool is not automatically **usable** for ranking:
`decideArenaPick`'s candidate filter drops anything `isModelRefUsable` rejects
(capped, drained, budget-gated, or absent from the provider's advertised
catalog and not in `allowUnlistedModels`), before ranking ever sees it. A new
Claude model added to a pool before it has a `CLAUDE_MODEL_MANIFEST` entry —
or an `allowUnlistedModels` waiver — sits in the pool forever without ever
being ranked, which read as an alias-table gap in `arena-aliases.ts` the one
time it happened (`claude-sonnet-5-5`, fixed by adding its manifest entry)
but was actually this.

## Fail-open order (R8)

Any doubt falls back to today's pool order, with the reason always recorded
(`decision-log.ts`'s `model.ranking.reason`) even on a fallback:

- `disabled` — `arena` is absent or `enabled` is `false`.
- `leader` — this rule never evaluates a leader; no `ranking` field on its decision. Leaders get `leaderRanking` from the leader pick instead.
- `role-out-of-scope` — the resolved role isn't in `arena.roles`.
- `declared-class` — a `paseo.task-class` label decided the class: a declared label always wins.
- `unknown-kind` — no `work_kind` answer, the role isn't a reviewer, or the answer is `other`.
- `no-file` — the rankings file is missing or stale (indistinguishable by the time it reaches the classifier).
- `no-ranked-board` — every board in the kind's list has fewer than two usable, ranked candidates.

A ref the usability check rejects (the same bar `selectModel` applies —
capped, drained, budget-gated, or a Codex ref with its guard red) is dropped
before ranking and never counts toward the two-candidate floor.

## Top tier, rarely (KTD-2)

`arena.topTier` refs are removed from standard and mechanical candidates
entirely. On a hard task they stay in the running, but win only when their
CI lower bound clears the best mid-tier candidate's CI upper bound by
`topTierMarginCi` extra CI widths (zero by default — a plain non-overlap
win). Losing that comparison picks the best mid-tier candidate instead,
still a `"ranked"` outcome, not a fallback.

Two candidates whose CIs overlap are a tie, settled by operator pool order —
never by raw score alone.

## Explicit requests

An eligible explicit `config.model` request (one of the resolved pool's own
entries, currently selectable) is not automatically exempt from ranking.
`decideModel` still computes the ranked pick for it, and:

- **Shadow** (`arena.shadow: true`, the default): the request is honored
  exactly as before U8 existed. The would-be pick is recorded on the decision
  (`model.ranking`, `applied: false`) and on `paseo.arena-pick`
  (`applied=0`) — the same visibility an ordered-selection create gets,
  without ever applying against an honored request.
- **Live** (`arena.shadow: false`): the ranked pick overrides the request,
  the same way it reorders today's pool order for a request-free create.
  `model.outcome` becomes `"selected"`, not `"honored-request"`, and
  `model.override.reason` is `"arena-ranked"` — visibly different from a
  `"not-approved"`/`"not-currently-selectable"` policy refusal, since the
  request was never refused; a better-ranked candidate ran instead.
- **`paseo.model-pin`** (any non-empty value, caller-set): keeps the request
  over the ranked pick even in live mode. The decision still records the
  would-be pick at `applied: false`.
- **Self-match**: the ranked winner can legitimately be the exact model (or
  its dated/undated `sameModel` alias) already requested — ranking reorders
  the whole class pool independent of any one request. That is not an
  override: `model.outcome` stays `"honored-request"` and no `override` is
  produced, but `model.ranking.applied` stays truthful to whichever mode
  picked it (`true` live, `false` shadow) rather than being forced to
  `false` — the ranked model and the requested model are the same, so
  nothing was overridden to claim.

Pin, shadow, and a self-match are the only cases where an honored request
carries a `ranking` field at all. Outside a self-match, `decideModel` never
returns `"honored-request"` with `ranking.applied: true` — that combination
would otherwise mean the decision log and `paseo.arena-pick` claim a ranked
model ran while a different, explicitly-requested model actually did.
`decision-log.ts` and `role-router.ts`'s `applyArenaPickLabel` both also
guard against that combination, belt-and-suspenders.

## Labels

- `paseo.work-kind` (`docs/jev.md`): the kind JEV named, written whenever
  asked — including a declared child, purely as a record, since the
  declared label already decided the model there.
- `paseo.arena-pick`: written for any `"ranked"` outcome, applied or not —
  including a shadowed or pinned explicit request (see "Explicit requests")
  — never for a fallback.
  `v1;ref=<ref>;tier=<top|mid>;board=<board>;date=<publishDate>;applied=<0|1>;proxy=<0|1>`.
  A leader pick appends `;role=leader;incumbent=<ref>;streak=<won>/<needed>`,
  with `tier=top` and `date` the board's own publish date. Readers must parse
  by key and ignore keys they don't know. Every pre-ledger pick is backfilled
  from this label (see "Decisions ledger and dashboard"), which skips a
  leader row (`role=leader`) rather than mixing a leader-pick decision into
  worker/reviewer ranking stats.
- `paseo.model-pin`: set by the caller, read only by `decideModel`. Keeps an
  eligible explicit request over the ranked pick in live mode; has no effect
  in shadow (the request is already honored there) or on a role outside
  `arena.roles`.
- `paseo.classifier-decision-id` (`decision-log.ts`'s `CLASSIFIER_DECISION_ID_LABEL`): a sibling
  of the decision log's own pairing token, but never stripped — the ledger's `agent.created`
  handler reads it to resolve the pending row it noted before the agent existed. See "Decisions
  ledger and dashboard".

## Shadow

With `arena.shadow` on (the default), `decideModel` still computes the full
ranked decision and records it — `applied: false`, the pool untouched — so
the leader can read a day of would-be picks before flipping `shadow: false`.
This includes an eligible explicit request: it is honored as it always was,
with the would-be pick recorded alongside it rather than discarded.

## Leaders

A leader is the longest-lived, most expensive agent in the fleet, and a model
switch rebuilds its whole prompt cache. So the leader pick is a separate rule
(`decideLeaderPick` in `server/arena-model-pick.ts`) that keeps the operator's
default unless something beats it clearly and for a while. The research behind
its defaults is `docs/design-notes/2026-10-20-leader-model-research.md`.

**Policy.** `agentModelPolicy.arena.leader`, absent by default:

| Field             | Default                                                | Meaning                                                                                      |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `enabled`         | `false`                                                | Off means a leader's decision is exactly what it was before this existed.                    |
| `shadow`          | `true`                                                 | Record the pick, never apply it.                                                             |
| `boards`          | `["agent/overall", "text_style_control/hard_prompts"]` | Walked in order. Only `LEADER_BOARD_IDS`, the boards that keep history.                      |
| `marginCi`        | `1`                                                    | Widths of the challenger's own CI its lower bound must clear the incumbent's upper bound by. |
| `streakPublishes` | `3`                                                    | Consecutive publishes the same challenger must win. At most 10, the history kept.            |

**The rule.**

- The incumbent is the leader role's first pool entry. Candidates are only the
  leader pool's other usable entries; Codex is never one.
- On each board in order, the newest publish must rank the incumbent and at
  least one challenger, or the next board is tried. The best-rated challenger
  there is fixed for the streak.
- The streak counts consecutive newest-first publishes where that challenger
  clears the bar (`clearsLeaderBar`, `shared/arena-leader-rule.ts`). A
  challenger whose row is an effort proxy while the incumbent's is not pays
  one more width. A publish missing either row ends the count.
- A full streak makes the challenger the pick; anything less keeps the
  incumbent. Ties, near-misses and short streaks all keep pool order.

In score terms, one width at today's widths is roughly a 0.10 lead on
`agent/overall`. When Fable 5.1 led Opus 5.5 for four publishes (2026-09-27 to
10-02), its CI never cleared Opus 5.5's, so the rule would not have moved.

**Decided once, at create.** The pick runs only in the `before("agent.create")`
hook. Resume, reload and account moves never run that hook, so a running
leader's model never changes. A create carrying `handoff-from` (a failover
import successor) falls back with `successor` even if a future path runs the
hook for it. Thinking stays the leader rule's level; account routing, budget
gates and failover are unchanged.

**Live mode.** With `shadow: false` and a full streak, the leader pool is
reordered so the challenger runs. The app sends the remembered model on almost
every root create, so an explicit request that names the incumbent follows the
pick (recorded as an `"arena-ranked"` override). Any other explicit model, or
`paseo.model-pin`, is honored.

**History.** `arena-rankings.json` carries `leaderHistory` (per leader board,
the last 10 publishes, newest first) and `boardTop` (each leader board's top 10
rows, matched or not). History is keyed on the rows' own
`leaderboard_publish_date`. The file's `publishDate` is the fetch date and
changes every run, so it can't tell a new publish from a repeated one. A
refresh sees only the latest publish, so two publishes between daily
refreshes leave one unrecorded. A retry that recovers a leader board records
its publish too.

**Record.** `model.leaderRanking` on the decision (kept apart from the worker
`ranking`), `leaderRanking` on the decision-log line, a sentence on the model
reason, and `paseo.arena-pick` with the leader keys. Fallback reasons:
`disabled` (only from the pure core; the classifier skips a disabled block
entirely), `successor`, `no-file`, `no-ranked-board`.

**Unpooled challengers.** `findUnpooledLeaderChallengers`
(`shared/arena-unpooled.ts`) lists models that clear the incumbent on the first
leader board by the same bar, with no streak, but match no role's pool,
including models the alias table doesn't map. The settings explain RPC returns
them as `unpooledLeaderChallengers`. The Decisions summary shows the top one
as a single line ("GPT-7 ranks above Claude Opus 5.5 on the agent board and is
in no pool."), fleet-wide whatever the filters, and nothing when there is
none. Names come from the rows' Arena display names (`boardTop[].displayName`,
effort suffix dropped); a file written before that field falls back to the
canonical name and our ref.

## Decisions ledger and dashboard

The `classifier-decision` line above is the only record of a decision, and
the daemon log rotates — a shadow day's picks are gone once the log is. The
plugin also writes a durable, bounded ledger at
`$PASEO_HOME/classifier/decisions.json` (a Zod-validated array capped at
5,000 rows, atomic writes, newest dropped last — not JSONL, since this
repo's stores rewrite the whole file atomically rather than appending), so a
day's picks outlive log rotation and a daemon restart.

A row is written at the same point `decision-log.ts`'s `finish()` writes its
log line, for any decision whose `model.ranking` field is present (every
non-leader create `decideArenaPick` was asked about, ranked or fallback).
The create hook runs before the daemon mints an agent id, so the row is
buffered (`notePending`) under a fresh, never-stripped
`paseo.classifier-decision-id` label — a sibling of `paseo.decision-log-token`
that, unlike that one, rides onto the real agent — and resolved
(`resolveAgent`) once `agent.created` names it. A row is a snapshot: role,
task class, work kind, the model that ran, and the would-be pick or fallback
reason, as decided. It never stores outcome — an agent's status, completion
state, and failover history keep changing after its decision was made, so
the dashboard joins each row against the agent's CURRENT state (`lastStatus`,
`archivedAt`, `paseo.completion`, `paseo.account-failover.migrated-to`,
`totalTokens`) at read time instead.

The 280-odd picks that predate the ledger are not lost: a one-time backfill
(gated by a `backfilledAt` marker on the ledger file itself) pages through
the plugin's sanctioned `paseo.agents.list()` API — never the agent-storage
filesystem layout directly — and reconstructs one row per agent carrying
`paseo.arena-pick`, from that label plus its sibling `paseo.agent-role` /
`paseo.task-class` / `paseo.work-kind` labels. A backfilled row is marked
`backfilled: true` and carries no fallback reason and no score detail
(rating/votes/effort) — the compact label format has no room for either —
but `modelRan` is recovered from the agent snapshot (`runtimeInfo.model`, the
actual model, falling back to the configured `model`) rather than left
`null`, since a historical row that can never agree or disagree is the one
thing that would make the dashboard's headline agreement rate read "—" for
every pre-ledger row on day one. The
label parser reads by key and ignores any it doesn't recognize, so a leader
pick's `;role=leader;incumbent=<ref>;streak=<won>/<needed>` suffix (see
"Leaders") never breaks parsing — but a leader row is skipped from the
backfill entirely: its pick is the leader rule's incumbent-vs-challenger
decision, not the worker/reviewer ranking this dashboard's agreement and
pick-distribution stats are about, and `tier` on a leader pick is always
`top` by construction, which would otherwise inflate `topTierRate` with
numbers that mean something unrelated.

The plugin RPC pair `classifier-decisions.list` / `.summary`
(`shared/classifier-decisions-rpc.ts`) serves the dashboard: `list` returns
paginated rows (newest first, with a `disagreementsOnly`/`role`/`workKind`
filter), `summary` returns the agreement rate, the would-be pick distribution
by model and tier, the top-tier rate, fallback reasons, the same splits by
work kind, and — per model actually run, split by work kind — the outcome
rate and median tokens, the only real performance evidence there is, since a
would-be pick never ran.

The dashboard itself is a "Decisions" view on the plugin's existing Agent
Model Policy settings screen (a plain in-screen "Policy"/"Decisions" toggle,
not a second registered screen or a host tab primitive — neither exists),
read-only: it shows what shadow mode would have done and does not flip
`arena.shadow`.

## Tests and verification

- `shared/arena-aliases.test.ts`, `server/arena-rankings.test.ts`: the alias
  table, normalizing an agent-board row and a text-board row to one shape,
  the vote floor, atomic writes, fixture-based (small captured
  datasets-server responses under `server/__fixtures__/arena/`).
- `server/arena-model-pick.test.ts`: every fallback reason; ordinary ranked
  picks; CI-overlap ties; the hard/top-tier margin, including the proxy
  extra width and `topTierMarginCi`.
- `server/classifier.test.ts` ("arena-ranked model pick"): the full
  `decideModel` integration — the pool actually reorders, shadow leaves it
  untouched, a leader never carries a `ranking` field, an old policy without
  `arena` behaves exactly as before, and the explicit-request cases: live
  overrides an eligible request with `outcome: "selected"` and
  `override.reason: "arena-ranked"`; shadow still honors it with the
  would-be pick at `applied: false`; `paseo.model-pin` keeps it in live mode;
  and a self-match (including a dated/undated alias) stays `"honored-request"`
  with no `override` and `ranking.applied` left truthful.
- `server/decision-log.test.ts`, `server/role-router.test.ts`: `model.ranking`
  on the decision line; `paseo.arena-pick` written for a ranked outcome,
  including a shadowed or pinned honored request at `applied=0`, never for a
  fallback or an applied override against `"honored-request"`.
- `server/classifier-tool.test.ts`, `server/role-policy-rpc-handlers.test.ts`
  ("arena ranking" / "explain — arena ranking"): both wire the same
  `arenaRankingCache` the create hook uses, proving the settings preview and
  the agent-facing tool reflect a real ranked pick rather than always falling
  back to `"no-file"`.
- Leaders: `shared/role-policy-schema.test.ts` ("leader") for the policy block;
  `server/arena-rankings.test.ts` ("leader boards") for history and top rows,
  including dedupe on the board's own date and retry recovery;
  `server/arena-model-pick.test.ts` (`clearsLeaderBar`, `decideLeaderPick`) for
  the rule and a calibration case from real history; `server/classifier.test.ts`
  ("arena leader pick") for shadow, live and explicit requests;
  `server/decision-log.test.ts` and `server/role-router.test.ts` ("the leader
  pick") for the record and label; `shared/arena-unpooled.test.ts` and
  `server/role-policy-rpc-handlers.test.ts` ("unpooled leader challengers",
  plus the save carrying `arena` through).
- `client/settings/explain-summary.test.ts`: `describeRequestedModel` renders
  the `"arena-ranked"` override reason with its own explanation, not the
  `"not-approved"` fallback text.
- `server/classifier-decisions-ledger.test.ts`: appending a ranked and a
  fallback row; the 5,000-row cap drops the oldest first; a flush/reload
  round-trips through the schema; a flush failure never throws and retries
  on the next tick; an unreadable or malformed file is quarantined
  (`<path>.corrupt-<ts>`) rather than silently replaced, and a single bad row
  drops only itself; `appendBackfill` runs once, gated by `backfilledAt`.
- `server/classifier-decisions-backfill.test.ts`: one row per agent carrying
  `paseo.arena-pick`, `backfilled: true`, no fallback reason, stamped with
  the agent's own `createdAt`; a leader row (`role=leader`) and a failover
  successor (`handoff-from`) are both skipped rather than double-counted or
  mixed into worker/reviewer stats; paging through every page, including
  archived agents; a malformed label counted as skipped, not silently
  dropped; the marker is set only after a complete sweep — a thrown page or
  the page cap running out leaves it unset so the next start retries; a
  second run after `backfilledAt` is a no-op and does not re-page.
- `shared/classifier-decisions-aggregate.test.ts`: `joinOutcome`'s state
  mapping off the real `status` field (archived beats error; running/
  initializing vs idle/closed), completion and moved-flag reads, the
  `durationMs` latest-timestamp rule; `rowAgreement` resolving a provider-
  prefixed pick ref against a bare `modelRan` and reading "unknown" (not
  "disagree") for a row with no `modelRan`; `summarize`'s agreement rate
  excluding unknown rows from its denominator (overall and by work kind,
  `null` not `NaN` when every row is a fallback), pick/tier distribution,
  fallback-reason counts, and median tokens per model per work kind.
- `server/classifier-decisions-rpc-handlers.test.ts`: `list` and `summary`
  filtered identically by role/work kind; `disagreementsOnly` via
  `rowAgreement`; an id-based `list` cursor that survives a row prepended
  between two Load-more calls; the agent sweep cached and single-flighted
  across calls within its TTL; an empty ledger returning an empty list and a
  zeroed summary, not an error.
- `index.server.test.ts`: the full create-hook wiring — the correlation
  label survives while the decision-log pairing token is stripped, `agent.
created` resolves the pending row into the ledger file, and a leader
  create produces no row even though it still carries the label.
- Verify: `cd plugins/claude-account-pool && npx vitest run server/arena-model-pick.test.ts server/arena-rankings.test.ts server/classifier.test.ts server/decision-log.test.ts server/role-router.test.ts server/classifier-tool.test.ts server/role-policy-rpc-handlers.test.ts shared/role-policy-schema.test.ts shared/arena-unpooled.test.ts server/classifier-decisions-ledger.test.ts server/classifier-decisions-backfill.test.ts shared/classifier-decisions-aggregate.test.ts server/classifier-decisions-rpc-handlers.test.ts index.server.test.ts --bail=1`.
