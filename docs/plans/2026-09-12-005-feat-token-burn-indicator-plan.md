# Relative token-burn indicator on agent rows

Status: design complete, ready for phased implementation (server field → app rendering → provider parity).
Provenance: design agent (Sonnet 5, four Explore researchers) on 2026-09-11; verified against the tree at `4f1e90c63`.

## User ask

"Some indication in the agent list, visually, maybe color coded to show sub agents token use relative to others so like a red one would tell me it's churning tokens too hard and I need to investigate."

## Interpretation (validated)

A recent burn RATE (tokens/min over a trailing ~5 min window), normalized RELATIVE to the currently visible sibling agents, rendered as a color-coded badge only when an agent burns meaningfully faster than peers right now. Rules out absolute thresholds (no "relative to what") and lifetime totals (no "right now").

## Current-state evidence

### What the daemon already sees

- Claude SDK result messages carry `usage` (per-turn, main-loop only), `modelUsage` (cumulative), `total_cost_usd`, `num_turns` (`sdk.d.ts:4643-4720`). Handler: `providers/claude/agent.ts:4447-4474` → `buildResultUsage` (`:1953-1985`) → shared `AgentUsage {inputTokens, cachedInputTokens, outputTokens, totalCostUsd}`. Claude's token fields are **already per-turn deltas**.
- Dropped today: `num_turns`, `modelUsage` breakdown, raw `cache_creation_input_tokens`.
- Already live-only + on the wire: `agent.lastUsage` (`agent-manager.ts:410`, set in `onStreamTurnCompleted` `:4367-4393`), `AgentSnapshotPayloadSchema.lastUsage` (`messages.ts:875`), projected in `toAgentPayload` (`agent-projections.ts:142-145`), never persisted. But it reflects only the most recent turn — no history, no rate.
- **Provider semantics diverge**: Claude = per-turn deltas; OpenCode = adapter-accumulated running totals (`opencode-agent.ts:3308`, `:950`); Codex/ACP = no cost; OMP/Pi = poll-based. A shared diff formula in agent-manager would be wrong for someone → **delta computation must be provider-local**.

### The `lastActivitySummary` template (mechanics to copy)

Pure compute returning `T | undefined`; in-memory field on `ManagedAgent` (`:412-418`); `!==` change gate; rides existing `emitState({persist:false})`; excluded from `toStoredAgentRecord`; bare `.optional()` on both payload schemas with **no COMPAT tag** (permanently-optional additive field); cleared on rewind (`:3150-3152`); consumed client-side with `?.`-guards.

### Color/severity vocabulary (reuse, don't invent a 4th scheme)

- `ProviderUsageTone = "default"|"ok"|"warning"|"danger"` (`messages.ts:5963`); house thresholds 70/90 (`quota-fetcher/usage.ts:79-84`, `provider-usage/tone.ts`); rendered with `theme.colors.statusSuccess/Warning/Danger` (`window-bar.tsx`; theme.ts:126-160 "status badges, usage bars").
- Distinct from `getStatusDotColor`'s lifecycle-only band — do NOT conflate.
- `ContextWindowMeter.getMeterColors` is a pre-existing third variant; don't add a fourth.
- **Decision: `ProviderUsageTone` vocabulary + status band, computed client-side only** (relative tone can't be server-computed — the server doesn't know the visible sibling set). Only raw numbers travel on the wire.
- Visual form: **`StatusBadge`** (icon + label — color never alone, per `status-badge.tsx` precedent + design.md), rendered ONLY for warning/danger. Attach points: `OrchestrationRow` trailing slot (`orchestration-panel.tsx:186-291`), `SubagentsTrackRow` (`subagents/track.tsx:178-250`, net-new), sidebar agent list if room (else phase-2 follow-up).
- Coding-standards rule that places the computation: collection rows never independently subscribe — the **list owner** derives a keyed row model with `useMemo`.

## Resolved decisions

| Decision           | Choice                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Server computes    | `recentTokenRate` (tokens/min, trailing 5-min window) + live-only `totalTokens`                                                     |
| Bucketing          | In-memory ring of 30s buckets ×10, created lazily on first turn (idle agents cost zero)                                             |
| Per-provider delta | Provider-local `turnTokenDelta` on the `turn_completed` stream event; Claude only in phase 1 (others show absence, never fake zero) |
| Emission           | Rides `onStreamTurnCompleted`'s existing broadcast — zero new timers/emits                                                          |
| Persistence        | None; cleared on restart and rewind (matches lastUsage/lastActivitySummary)                                                         |
| Tone               | Client-side, at list owner, over currently visible siblings                                                                         |
| Pool floor         | ≥3 siblings with usable rates, else `default`; absolute floor 1,500 tok/min (tunable)                                               |
| Hysteresis         | danger enter ≥3.0× median / exit <2.25×; warning enter ≥1.75× / exit <1.4×                                                          |
| Staleness          | `now - asOfMs > 10 min` (2× window) ⇒ treated as absent                                                                             |
| Missing data       | Excluded from pool + no badge — never a neutral color implying "measured calm"                                                      |
| totalTokens        | Tooltip/long-press only, never drives color                                                                                         |

## Server design

1. `agent-sdk-types.ts` (near `AgentUsage` :230-237): `AgentTokenRateBucket {bucketStartMs, tokens}`, `AgentTokenRate {tokensPerMinute, asOfMs}`; `turn_completed` union member (+ mirror in `protocol/agent-types.ts:378-379`) gains `turnTokenDelta?: number`.
2. Provider-local delta: Claude — `usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens` at the `buildResultUsage` site (already per-turn). OpenCode/Codex/ACP/OMP/Pi: phase 3.
3. New pure module `packages/server/src/server/agent/token-rate-tracker.ts`: `recordTokenDelta(buckets, delta, nowMs)` (prune > 5 min), `computeTokenRate(buckets, nowMs) → AgentTokenRate | undefined` (undefined when empty — never fabricated zero; divide by actual elapsed span, clamped to [30s, 5min]).
4. `agent-manager.ts`: `ManagedAgent.tokenRateBuckets?/totalTokens?` next to `lastUsage`; update in `onStreamTurnCompleted` after the lastUsage merge, only when `turnTokenDelta > 0`; no new emitState; rewind clears both.
5. `messages.ts`: `AgentTokenRateSchema {tokensPerMinute, asOfMs}`; `recentTokenRate` + `totalTokens` bare-optional on `AgentSnapshotPayloadSchema` AND `AgentListItemPayloadSchema` (no COMPAT tag). Verify at implementation time whether `lastUsage` exists on the list-item schema — additive either way.
6. `agent-projections.ts`: compute in `toAgentPayload` + `toAgentListItemPayload`; `toStoredAgentRecord` untouched.

## Client design

1. New pure model `packages/app/src/utils/token-burn-tone-model.ts`: `resolveTokenRate(rate, nowMs) → number | undefined` (stale ⇒ undefined); `deriveTokenBurnTones(siblings, previousTones) → ReadonlyMap<id, TokenBurnTone>` — median of above-floor resolved rates, ≥3-sibling pool requirement, hysteresis via previous-tone param; entries only for siblings with resolved rates (missing entry = no badge, NOT "default").
2. Computed once per render at the list owner (`useMemo` + ref for previous tones), never per-row.
3. Rendering: `StatusBadge` (danger→"error", warning→"warning") in `OrchestrationRow`'s trailing slot pattern and `SubagentsTrackRow`; tooltip/long-press shows exact numbers via `formatTokenCount`/`provider-usage/format.ts` (e.g. "12.4K tok/min · 340K total"). `toSubagentRow` passes through raw `recentTokenRate`.

## Test list

**Server:** token-rate-tracker (same-bucket accumulation, new bucket, pruning, undefined-when-empty, span clamping, zero/negative ignored); Claude turnTokenDelta from fixture SDKResultMessage; agent-manager updates buckets/total with no extra emitState; projections include-when-present/omit-when-absent/never-stored; rewind clears.
**Client:** tone model (lone-agent default; all-idle default; ≥3× median of ≥3 above-floor siblings → danger; same ratio below floor → default; hysteresis hold/drop; stale excluded; missing excluded without skewing median); badge renders only warning/danger; tooltip formatting.

## Phasing

1. Server field, Claude only — land + observe real traffic.
2. App rendering — tune floor/hysteresis constants against phase-1 data before locking defaults.
3. Provider parity (Codex/OpenCode/ACP/OMP/Pi turnTokenDelta) — non-blocking follow-up.
