# Arena-ranked model pick

Reorders a worker or reviewer's already-approved model pool by the LMArena
leaderboard, so the classifier picks the best-ranked candidate for the kind
of work instead of always the operator's first pool entry. Ranking never adds
a model to a pool and never runs for a leader. Credit: "LMArena leaderboard
dataset (CC-BY-4.0)" — https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset.

## Data flow

1. **The daily job** (`server/arena-rankings.ts`) fetches the boards in the
   table below from the Hugging Face datasets-server JSON API, normalizes
   model names through a hand-kept alias table (`shared/arena-aliases.ts`,
   exact match only — an unmatched name is dropped and counted, never
   guessed), drops rows below the vote floor, and writes
   `$PASEO_HOME/arena-rankings.json` atomically. A failed refresh keeps the
   old file.
2. **The plugin cache** (`server/arena-ranking-cache.ts`) re-reads that file
   on an interval and feeds it to the classifier as `ClassifierWorld.arenaRanking`
   — undefined when the file is missing or older than `arena.maxAgeHours`.
   Staleness is resolved here, before the classifier ever sees the file: the
   pure ranking core treats "missing" and "stale" identically, as one fallback.
3. **`decideArenaPick`** (`server/arena-model-pick.ts`) is the pure core: given
   a role's pool, the kind of work, and the cached rankings, it decides a
   ranked pick or a fallback. `decideModel` (`server/classifier.ts`) calls it,
   then — unless `arena.shadow` is on — reorders the pool so the pick runs.
   `classifyAgent` stays pure throughout: rankings arrive as world data, never
   a fetch.

## Policy shape

`agentModelPolicy` gains an optional `arena` key (`shared/role-policy-schema.ts`'s
`ArenaPolicySchema`). Absent entirely — the common case for an old config —
behaves exactly as before: zero extra computation, no `ranking` field on any
decision.

| Field             | Default                  | Meaning                                                                             |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `enabled`         | `false`                  | Master switch.                                                                      |
| `shadow`          | `true`                   | Records the would-be pick without applying it (D6, "shadow first").                 |
| `roles`           | `["worker", "reviewer"]` | Policy role ids ranking applies to. The classifier refuses `leader` even if listed. |
| `topTier`         | `[]`                     | Refs dropped from standard/mechanical candidates; win a hard pick only rarely.      |
| `topTierMarginCi` | `0`                      | Extra CI widths a top-tier pick must clear beyond a plain non-overlap win.          |
| `maxAgeHours`     | `72`                     | How stale the rankings file may be before falling back.                             |

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

## Fail-open order (R8)

Any doubt falls back to today's pool order, with the reason always recorded
(`decision-log.ts`'s `model.ranking.reason`) even on a fallback:

- `disabled` — `arena` is absent or `enabled` is `false`.
- `leader` — never evaluated at all for a leader; no `ranking` field on its decision.
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

## Labels

- `paseo.work-kind` (`docs/jev.md`): the kind JEV named, written whenever
  asked — including a declared child, purely as a record, since the
  declared label already decided the model there.
- `paseo.arena-pick`: written only for a `"ranked"` outcome, never a
  fallback. `v1;ref=<ref>;tier=<top|mid>;board=<board>;date=<publishDate>;applied=<0|1>;proxy=<0|1>`.

## Shadow

With `arena.shadow` on (the default), `decideModel` still computes the full
ranked decision and records it — `applied: false`, the pool untouched — so
the leader can read a day of would-be picks before flipping `shadow: false`.

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
  `arena` behaves exactly as before.
- `server/decision-log.test.ts`, `server/role-router.test.ts`: `model.ranking`
  on the decision line; `paseo.arena-pick` written only for a ranked outcome.
- Verify: `cd plugins/claude-account-pool && npx vitest run server/arena-model-pick.test.ts server/arena-rankings.test.ts server/classifier.test.ts --bail=1`.
