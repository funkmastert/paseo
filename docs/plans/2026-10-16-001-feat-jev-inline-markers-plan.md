---
title: JEV inline stream markers - Plan
type: feat
date: 2026-10-16
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# JEV inline stream markers - Plan

## Goal Capsule

- **Objective:** show a small, quiet JEV chip inline in an agent's stream wherever JEV decided something for that agent (model picked at spawn, read skipped/flagged, title set, notification triaged, stall judged, remediation triaged, away reply sent), placed by timestamp between the rows it falls between. Several decisions landing in the same gap collapse into one chip with a count. Tapping a chip opens the existing tap-triggered popover primitive with the question, verdict/confidence, what code did (applied / shadow-only — marked "would have" / vetoed), and cost. Shadow decisions show, visibly marked. Live while the session is open, on every surface (web, Electron, iOS, Android; compact/wide; pinned-grid cells).
- **Authority:** this plan, then `docs/jev.md`, `docs/agent-stream-performance.md`, `docs/design.md`, `docs/hover.md`, `docs/floating-panels.md`, `docs/protocol-compatibility.md`, `CLAUDE.md` platform-gating section. Audit: `~/bozeo-ops/reviews/jev-integration-audit.md`.
- **Execution profile:** single worktree, single implementer, sequential units U1 → U4 (each depends on the last). No parallel workers needed at this size.
- **Stop conditions:** stop and report, don't guess, if placing markers would require touching `layoutStream`'s turn-membership/grouping logic (`turn-membership.ts`, `spacing.ts`) beyond adding a pass-through case, or if the decision store lacks a parseable timestamp for a feature that needs one.
- **Tail ownership:** commit locally on `feat/jev-inline-markers`; never push. The leader runs the wider review, merge, and device verification.

---

## Product Contract

### Problem Frame

Tyler: "the jev dashboard still looks like Jev isnt really part of the workflows." The audit found this is a visibility problem, not a missing-feature problem: per-agent JEV decisions already exist (`jev.decisions.list.request` / `client.listJevDecisions(agentId)`, consumed today by `JevDecisionsSection` inside the context-usage meter's popover). A normal glance at an agent's stream shows nothing — the data only surfaces behind a 28×28px ring icon's tooltip. Tyler chose inline markers over timeline rows; timeline rows were already tried and reverted because a `jev_decision` row in the persisted agent timeline breaks account-failover dating (`docs/jev.md`, `~/bozeo-ops/jev-build-STATE.md:35-36`). The fix must stay client-only and never touch the persisted/replicated timeline.

### Requirements

- R1. A small chip renders inline in the stream at the point a JEV decision landed, for every decision kind the daemon records (the decision record's `feature` field covers all of spawnHint, readCheck, titleRefresh, notificationTriage, stallJudgment, remediationTriage, awayReply — no feature-specific UI branches needed).
- R2. Chips are ordered into the stream by the decision's timestamp, sitting between the two rows it falls between. A decision whose timestamp precedes the first row sits at the top of history.
- R3. Decisions landing in the same gap between two rows collapse into one chip carrying a count.
- R4. Tapping a chip opens a tap-triggered popover (reusing the `Tooltip`/`TooltipContent`/`FloatingScrollView` primitive already used by `ContextWindowMeter` for exactly this cross-platform tap-to-reveal pattern) showing, per decision: feature label, question, verdict, what code did (applied / vetoed), a "would have: …" phrasing when the decision was shadow-only, and cost.
- R5. A session that is open picks up new decisions without a reload, at the same cadence the meter popover already polls at (15s, shared query key/cache) — no new or faster polling.
- R6. The feature is client-only: the daemon's decision store and RPC are the only data source; no new server or protocol field. Markers are synthesized at render time from `JevDecisionRecord[]` and are never written into the persisted timeline, the client replica cache, or any plugin-visible timeline projection.
- R7. Works on every surface the agent stream already renders on (web, Electron, iOS, Android; compact/wide; pinned-grid cells) because it is implemented once inside `AgentStreamView`, the single component all of those surfaces already share — no platform- or form-factor-specific branch needed.
- R8. Chips are quiet/small (`docs/design.md` density), never use `onPointerEnter`/`onPointerLeave` or raw DOM outside `isWeb` (`CLAUDE.md`), and must not cause the whole stream to re-render on a streaming tick (`docs/agent-stream-performance.md`) — markers are memoized by the decision-list's identity, not recomputed on every text-chunk flush.
- R9. i18n keys for the chip's label and popover copy exist in every locale resource file.
- R10. The context meter's popover `JevDecisionsSection` is unchanged.

### Scope Boundaries

- No server or protocol change. `JevDecisionRecord` already carries `at` (ISO timestamp), `feature`, `question`, `verdict`, `action`, `applied`, `mode`, `costUsd`, `callId` — enough to place, label, and detail every marker. If a future feature's record turns out not to carry a usable timestamp, that is a stop condition (see above), not a silent skip.
- No change to `layoutStream`'s turn-grouping, spacing, or tool-sequence logic beyond the one pass-through case a new `StreamItem` kind needs (verified in research below: `turn-membership.ts` and `spacing.ts` key off specific kinds like `"user_message"`/`"assistant_message"`/`"tool_call"`/`"thought"`/`"todo_list"` and fall through generically for anything else — a marker item needs no new branch there).
- No new hook/subscription plumbing: `useAgentJevDecisions` already defaults to `enabled: true` and is keyed by `agentJevDecisionsQueryKey(serverId, agentId)`, so calling it again from `AgentStreamView` shares the same react-query cache and 15s `refetchInterval` the popover already uses — it does not double the polling rate.
- E2E and real-device verification (iOS/Android simulators, Electron, mobile Safari/Chrome) — rapid mode; targeted unit tests only. The leader verifies on-device before merge.
- No change to which decisions are recorded, their promotion rules, or any of the fix-plan items in the audit (spawnHint sign flip, awayReply presence scoping, etc.) — those are separate, Tyler-gated decisions, out of scope here.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Markers are a new `StreamItem` union member (`kind: "jev_marker"`), synthesized client-side, never persisted.** Researched precedent: `CompactionItem`/`PluginTimelineStreamItem` show the established pattern (new `kind`, a render-switch case, `id`+`timestamp` so ordering "just works" through `layoutStream`), but both of those are real, persisted/replicated timeline entries. A marker must not be. Verified touch points for a new `StreamItem` kind:
  - `packages/app/src/types/stream.ts` — add the union member (required).
  - `packages/app/src/agent-stream/view.tsx` `renderStreamItemContent` — add a render case (has a `default: return null`, so required only for the chip to actually render, not for compilation).
  - `packages/app/src/runtime/replica-cache/index.ts` `serializeTimelineItem` — **exhaustive switch, no default.** Add `case "jev_marker": return null;` (same pattern already used for `tool_call` when it can't be stored) — this is what guarantees a marker is never written into the client's local replica cache. `deserializeBuiltinTimelineItem`'s parameter type is `Exclude<StoredTimelineItem, {kind:"plugin"}>`; since `jev_marker` is never added to the stored/replicated union, no case is needed or possible there — confirms markers can't round-trip through storage.
  - `packages/app/src/plugins/timeline/projection.ts` `sourceTimelineItem` — **exhaustive switch, no default.** Add `case "jev_marker": return null;` (same as the existing `"plugin"` case) so a marker is never exposed to an installed plugin's timeline transform.
  - `packages/app/src/agent-stream/web-virtualization.ts` `estimateStreamItemHeight` — has a `default: return 120`; add an explicit small-row estimate for a slightly better virtualization height guess (optional, low-risk).
  - `packages/app/src/agent-stream/layout.ts`, `turn-membership.ts`, `spacing.ts` — all generic over kind except explicit checks for `"user_message"`/`"assistant_message"`/tool-sequence kinds; a marker item falls through every one of those checks safely (no turn-footer, no spacing special case, `toolSequence: "none"`) — **no change needed**.
  - `packages/app/src/agent-stream/strategy.ts`/`strategy-native.tsx`/`strategy-web.tsx`, `history-window.ts`, `use-stream-history-window.ts` — id/count-based, not kind-based — **no change needed**.
  - Server-side timeline merging (`agent-stream-performance.md`'s pipeline) and `replica-cache`'s wire schema (`StoredTimelineItem` zod union) are untouched — a marker never reaches either.
- **KTD2 — Injection point is inside `AgentStreamView`, after tool-call/plugin projection, before `buildAgentStreamRenderModel`.** `effectiveStreamItems`/`effectiveStreamHead` (used by chat outline, sticky-last-prompt, prompt navigator) stay untouched — only the render-model's own `tail`/`head` inputs (`projectedPlugins.tail`/`.head`) get markers interleaved, via a new pure function `placeJevMarkers`. This must happen **before** `useStreamHistoryWindow` computes `historyWindowStart` (not after `buildAgentStreamRenderModel`'s internal slice), otherwise the slice index and the marker-shifted array disagree. The one decision-placement subtlety: `tail` and `head` are two separate arrays flowing through the same pipeline, so decisions have to be split between them by a single boundary (the last `tail` item's timestamp) so a decision is never placed into both, or dropped between them.
- **KTD3 — Live data reuses `useAgentJevDecisions` unmodified, called a second time (from `AgentStreamView`) with no `enabled` override**, so it defaults to `enabled: true` and shares `agentJevDecisionsQueryKey`/the 15s `refetchInterval` with the popover's own call — satisfies R5/R6 with zero new subscription code. React Query's default structural sharing keeps `data` referentially stable across unchanged refetches, which is what keeps the marker-building `useMemo` cheap on a streaming tick (R8) — the same stability assumption `projectedToolCalls`/`projectedPlugins` already rely on elsewhere in this file.
- **KTD4 — Marker line type reuses `JevDecisionLine` (already exported from `jev-decisions-model.ts`)** rather than inventing a parallel shape — `jevFeatureLabel`, `formatJevCost`, and the module-private `tagFor` (newly exported, unrenamed) format every marker line exactly the way the popover already formats its rows, so the two surfaces never drift in wording. Unlike the popover (`JEV_DECISIONS_SHOWN = 8`, newest-first), the marker builder keeps every decision with a parseable `at`, oldest-first, since markers must cover the whole visible history, not just the latest few.
- **KTD5 — Details popover is a new small component (`JevMarkerChip`), not a reuse of `JevDecisionsList`.** `JevDecisionsList` carries popover-specific chrome (title, divider, "N older", "open all activity" link) that doesn't apply to a single stream position; the chip's popover is just the per-decision rows, reusing the same per-row layout shape as `JevDecisionRow` (duplicated, not imported, since that component isn't exported and pulling in the list's chrome would be wrong here).

---

## Implementation Units

### U1. Pure marker-placement model

**Goal:** turn a `JevDecisionRecord[]` + `JevStatus` into timestamp-ordered `JevDecisionLine`s, and interleave them into an arbitrary `{id, timestamp}` item array, collapsing same-gap decisions into one marker and splitting correctly across a tail/head boundary.

**Requirements:** R1, R2, R3, R6

**Dependencies:** none

**Files:**

- `packages/app/src/jev/jev-decisions-model.ts` — export the existing private `tagFor` (unrenamed); export the existing private `parseAt` as `parseJevDecisionAt` for reuse (unrenamed behavior).
- `packages/app/src/jev/jev-marker-model.ts` (new) — `buildJevMarkerLines(decisions, status): JevDecisionLine[]` (oldest-first, skips any record whose `at` doesn't parse); `splitJevMarkerLines(lines, tailBoundaryMs: number | null): { forTail; forHead }` (lines with `at <= boundary` go to `forTail`; when `tailBoundaryMs` is `null` — empty tail — everything goes to `forTail`, so a decision made before the very first row lands at the top of history rather than in the ephemeral live head); `placeJevMarkers<T extends {id: string; timestamp: Date}>(items: readonly T[], lines: readonly JevDecisionLine[]): Array<T | JevMarkerItem>` (single ascending pass, returns the original array reference unchanged when `lines` is empty, so an agent with no JEV activity never gets a new array identity); `createJevMarkerItem` (not exported) building the `id`/`timestamp` for a collapsed group.
- `packages/app/src/jev/jev-marker-model.test.ts` (new).

**Approach:** `placeJevMarkers` walks `items` once; before pushing each item, it drains every line whose `at.getTime() <= item.timestamp.getTime()` into a pending group, flushing the group as one `JevMarkerItem` right before that item. Any lines left over after the last item (newer than everything) flush at the end — this is what puts a decision made during the still-streaming turn at the bottom, and (combined with KTD2's boundary split) is also what correctly represents "before the first row."

**Test scenarios:**

- Empty `lines` returns the exact same array reference as `items` (identity check).
- A decision timestamped before the first item's timestamp produces one marker at index 0.
- Two decisions landing in the same gap collapse into one marker whose `lines.length === 2`.
- A decision newer than the last item flushes at the end of the array.
- `buildJevMarkerLines` skips a record with an unparseable `at` and keeps the rest, sorted oldest-first.
- `splitJevMarkerLines` with `tailBoundaryMs: null` puts everything in `forTail`; with a boundary, a line exactly at the boundary (`at === boundary`) goes to `forTail` (`<=`), one past it goes to `forHead`.

**Verification:** `npx vitest run packages/app/src/jev/jev-marker-model.test.ts`.

---

### U2. Marker chip + details popover component

**Goal:** a small, quiet chip that renders one or more collapsed `JevDecisionLine`s and opens a tap-triggered popover with the full detail, shadow decisions visibly marked "would have."

**Requirements:** R1, R3, R4, R8, R9

**Dependencies:** U1

**Files:**

- `packages/app/src/jev/jev-marker-chip.tsx` (new) — `JevMarkerChip({ lines }: { lines: JevDecisionLine[] })`. Chip: small pill (matches `StatusBadge`'s visual weight — `surface3` background, `foregroundMuted` text, `borderRadius.full`), a small `Gauge` icon (lucide-react-native, same icon the JEV dashboard sidebar entry already uses), label `t("jevMarker.chipLabel")` or `t("jevMarker.chipLabelCount", { count })` when `lines.length > 1`. Wrapped in the same `Tooltip`/`TooltipContent`/`FloatingScrollView` primitive `ContextWindowMeter` uses for its tap-triggered popover (`enabledOnDesktop enabledOnMobile`), so this is cross-platform and hover-free by construction (no `onPointerEnter`/`onPointerLeave`, nothing behind `isWeb`). Popover body: one row per line (feature, question, `verdict → action`, cost, and when `tag` is set, a `StatusBadge` plus `t("jevMarker.wouldHaveAction", { action })` instead of the plain action text).
- `packages/app/src/i18n/resources/en.ts` (and `ar.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `ru.ts`, `zh-CN.ts`) — add `jevMarker.chipLabel`, `jevMarker.chipLabelCount`, `jevMarker.accessibilityLabel`/`accessibilityLabelCount`, `jevMarker.wouldHaveAction`.
- `packages/app/src/jev/jev-marker-chip.test.tsx` (new, lightweight render test — not a full browser test, matching rapid mode) if an existing component test pattern in this package supports a plain render+snapshot/assert without a browser harness; otherwise defer to a `.browser.test.tsx` and note it as deferred-to-leader verification in the report (decide during implementation by checking `jev-decisions-list.browser.test.tsx`'s harness requirement).

**Approach:** Reuse `jevFeatureLabel`/`formatJevCost` formatting already applied to each `JevDecisionLine` by U1's `buildJevMarkerLines` — this component only lays the already-formatted strings out, it does no formatting of its own.

**Test scenarios:** covered by whatever test harness U2 settles on (component-level): single-line chip shows no count; multi-line chip shows `t("jevMarker.chipLabelCount")`; a line with `tag: "shadow"` renders the "would have" phrasing and the shadow badge; a line with `tag: null` renders the plain action text.

**Verification:** run whichever test file U2 adds.

---

### U3. Wire markers into `AgentStreamView`

**Goal:** make the chips actually appear in the live stream, on every surface, without re-rendering the whole list on a streaming tick.

**Requirements:** R2, R5, R6, R7, R8, R10

**Dependencies:** U1, U2

**Files:**

- `packages/app/src/agent-stream/view.tsx` — add, after `projectedPlugins` is computed and before `useStreamHistoryWindow`:
  - `useAgentJevDecisions(resolvedServerId, agentId)` (no `enabled` override — KTD3).
  - `jevMarkerLines = useMemo(() => buildJevMarkerLines(data?.decisions ?? EMPTY, data?.status ?? null), [data])`.
  - `tailBoundaryMs` from `projectedPlugins.tail`'s last item (or `null`), then `splitJevMarkerLines`, then `placeJevMarkers` into `tailWithJevMarkers`/`headWithJevMarkers`.
  - Feed `tailWithJevMarkers`/`headWithJevMarkers` (not `projectedPlugins.tail`/`.head`) into `useStreamHistoryWindow` and `buildAgentStreamRenderModel`. Leave `effectiveStreamItems`/`effectiveStreamHead` (chat outline, sticky-last-prompt, prompt navigator) untouched — KTD2.
  - `renderStreamItemContent`'s switch — add `case "jev_marker": return <JevMarkerChip lines={item.lines} />;`.
- `packages/app/src/types/stream.ts` — add `JevMarkerItem` import from `@/jev/jev-marker-model` and the union member.
- `packages/app/src/runtime/replica-cache/index.ts` — add the `case "jev_marker": return null;` from KTD1.
- `packages/app/src/plugins/timeline/projection.ts` — add the `case "jev_marker": return null;` from KTD1.
- `packages/app/src/agent-stream/web-virtualization.ts` — optional explicit height case.

**Approach:** No changes to `AgentStreamView`'s prop contract, `agentStreamViewPropsEqual`, or the pinned-grid caller (`panels/agent-panel.tsx`) — R7 (every surface, including pinned-grid cells) is satisfied for free because they all mount this same component (confirmed in research: pinned-grid cells render the identical `AgentStreamView`, just with `compact`/`readOnly`).

**Test scenarios:** covered by U1's pure-function tests; this unit is wiring, verified by typecheck + the existing `view.tsx`-adjacent tests that already exercise `buildAgentStreamRenderModel`'s callers, plus a manual read-through for the tail/head boundary math. No new test file planned for the wiring itself (rapid mode) — flag in the report if a quick regression test is cheap to add once the wiring is in.

**Verification:** `npm run typecheck`, `npm run lint -- packages/app/src/agent-stream/view.tsx packages/app/src/types/stream.ts packages/app/src/runtime/replica-cache/index.ts packages/app/src/plugins/timeline/projection.ts`.

---

### U4. i18n completeness + simplify pass

**Goal:** confirm every locale resource has the new keys, then run `ce-simplify-code` over everything touched.

**Requirements:** R9

**Dependencies:** U1, U2, U3

**Approach:** grep each locale file for the new `jevMarker.*` keys after U2; run `ce-simplify-code` per CE policy once U1-U3 are in.

**Verification:** `npm run format`, `npm run lint`, `npm run typecheck` clean across all touched files.
