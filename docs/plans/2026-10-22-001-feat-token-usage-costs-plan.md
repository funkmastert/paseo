---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# feat: Add API-equivalent cost to the Tokens screen

## Summary

The Tokens screen (`usage.tokens.get_breakdown`) shows token counts per provider/model/role for
24h/7d/30d. It has no notion of dollars. Add a server-side price table (Anthropic + OpenAI list
prices), compute a cost per row and range totals in the daemon, wire a new `tokenUsageCost`
feature flag, and surface the cost on each row, each role total, and a range total on the Tokens
screen — labeled as an API-equivalent estimate, never as money billed (Tyler's Claude accounts are
flat-rate subscriptions).

## Problem Frame

`docs/token-usage.md` and `usage.tokens.get_breakdown` report tokens only. Tyler wants to see what
that usage would have cost at API list prices, per row and as a total for the selected range, on
the existing Tokens screen — not a new screen, not real billing.

## Requirements

- R1. A server-side price table, per model, per token category (fresh input, cache write, cache
  read, output), with an "as of" date recorded in the source.
- R2. `usage.tokens.get_breakdown.response` carries a cost per row and range totals, as new
  optional protocol fields, gated on a new `server_info.features.tokenUsageCost` flag.
- R3. A model with no listed price shows "—" and is never guessed; the response says how many
  tokens were left unpriced.
- R4. The Tokens screen shows cost per row, per role, and as a range total, labeled
  "API-equivalent cost" (never "billed"), readable on phone and desktop.
- R5. Every new user-facing string goes through `t()` and is added to every locale file.
- R6. `docs/token-usage.md` documents the price table, its sourcing, and the two documented
  pricing assumptions (below).

## Key Technical Decisions

- **KTD-1: Price table lives server-side, one module, pure functions.**
  `packages/server/src/server/token-usage/token-usage-pricing.ts` exports a price-per-category
  table and `priceTokenUsage(provider, model, counts) => number | null`. The store calls it; the
  app never computes a price. Rationale: single source of truth, matches the existing
  `weighTokenUsage` pattern already imported into `token-usage-store.ts` from
  `../agent/token-rate-tracker.js`.

- **KTD-2: Claude model matching reuses `normalizeClaudeRuntimeModelId`.**
  `packages/server/src/server/agent/providers/claude/model-manifest.ts` already canonicalizes a
  raw transcript model string (dated snapshots, `[1m]` suffix, gateway prefixes) to a manifest id,
  anchored so `claude-opus-5-5` is never collapsed into `claude-opus-5`
  (`docs/model-divergence.md`). Reusing it for price lookup means one normalizer, not two, and it
  already has test coverage for the exact edge cases pricing needs (dated ids, `[1m]`). Codex
  model ids are not canonicalized — OpenAI's API model strings have no date-suffix or alias
  pattern in the transcripts (`docs/token-usage.md`), so an exact-string lookup is correct and
  simpler.

- **KTD-3: Cache-write duration (5m vs 1h) is assumed 5-minute.**
  `transcript-parsers.ts` sums Anthropic's `cache_creation_input_tokens` into one `cacheWrite`
  bucket; the stored buckets cannot tell a 5-minute write from a 1-hour write
  (`docs/token-usage.md`, "Transcript facts"). Claude Code's own cache breakpoints default to the
  5-minute TTL, so this plan prices every Claude cache write at the 5-minute rate (1.25x base
  input). Documented as an assumption in the price table's header comment and in
  `docs/token-usage.md`.

- **KTD-4: Claude Haiku 5.5's two-tier pricing (≤100K vs >100K prompt tokens) is assumed to be the
  ≤100K tier.**
  Haiku 5.5 is the only current Claude model priced by prompt length rather than flat per-MTok
  (source: `platform.claude.com/docs/en/about-claude/pricing`, "Long context pricing"). The hourly
  hourly buckets have no per-request prompt-length dimension to split on. Pricing at the lower
  tier undercounts cost on long-prompt Haiku calls; documented as an assumption rather than
  guessed per-request.

- **KTD-5: Unknown/unpriced models contribute to `unpricedTokens`, not a silent zero.**
  `TokenUsageGetBreakdownResponse.payload` gains `totalCostUsd: number | null` (sum of priced
  rows, `null` only when the feature is off or disabled) and `unpricedTokens: number` (sum of raw
  tokens — input+cacheWrite+cacheRead+output — across rows whose model has no price). The UI shows
  this as a footer note so the total doesn't read as complete when it isn't (R3).

- **KTD-6: A new `tokenUsageCost` feature flag, not reuse of `tokenUsage`.**
  Mirrors the existing `tokenUsage`/`compactionLedger` pattern
  (`docs/protocol-compatibility.md`): an old app talking to a new daemon ignores the extra fields;
  a new app talking to an old daemon (which has `tokenUsage: true` but not `tokenUsageCost`) hides
  the cost UI instead of rendering an all-"—" cost column. Advertised in `websocket-server.ts`
  whenever `tokenUsage` itself is (same underlying service), as its own COMPAT-tagged boolean.

- **KTD-7: USD formatting is fixed `en-US` `Intl.NumberFormat`, not locale-aware currency
  formatting.** The cost is explicitly a US-dollar API-list-price estimate (R-request), not the
  user's local currency — formatting it as `$1.23` regardless of UI language avoids implying a
  real currency conversion. Only the surrounding prose strings go through `t()`.

## Price Table (sources below; "as of" 2026-10-22)

**Anthropic** — `platform.claude.com/docs/en/about-claude/pricing`, fetched 2026-10-22. All $/MTok.
Cache write priced at the 5-minute rate (KTD-3); Haiku 5.5 priced at the ≤100K-token tier (KTD-4).

| Model (canonical id) | Input | 5m cache write | Cache read | Output |
| -------------------- | ----- | -------------- | ---------- | ------ |
| `claude-fable-5-1`   | 10.00 | 12.50          | 0.25       | 50.00  |
| `claude-mythos-5-1`  | 10.00 | 12.50          | 0.25       | 50.00  |
| `claude-fable-5`     | 10.00 | 12.50          | 1.00       | 50.00  |
| `claude-opus-5-5`    | 4.00  | 5.00           | 0.20       | 20.00  |
| `claude-opus-5`      | 5.00  | 6.25           | 0.50       | 25.00  |
| `claude-opus-4-8`    | 5.00  | 6.25           | 0.50       | 25.00  |
| `claude-opus-4-7`    | 5.00  | 6.25           | 0.50       | 25.00  |
| `claude-opus-4-6`    | 5.00  | 6.25           | 0.50       | 25.00  |
| `claude-sonnet-5-5`  | 2.00  | 2.50           | 0.10       | 10.00  |
| `claude-sonnet-5`    | 2.00  | 2.50           | 0.20       | 10.00  |
| `claude-sonnet-4-6`  | 3.00  | 3.75           | 0.30       | 15.00  |
| `claude-haiku-5-5`   | 0.10  | 0.125          | 0.01       | 0.50   |
| `claude-haiku-4-5`   | 1.00  | 1.25           | 0.10       | 5.00   |

**OpenAI/Codex** — `developers.openai.com/api/docs/pricing`, fetched 2026-10-22. All $/MTok, standard
(non-Fast) tier. Cache write priced the same as fresh input: OpenAI's prompt caching has no write
charge, only a discounted read (`cached_input_tokens` is a subset of `input_tokens` per
`docs/token-usage.md`, and `cache_write_input_tokens` is "always 0 so far", so this is inert today
but correct if it ever isn't).

| Model (exact id) | Input | Cache read | Output |
| ---------------- | ----- | ---------- | ------ |
| `gpt-5`          | 1.25  | 0.125      | 10.00  |
| `gpt-5-mini`     | 0.25  | 0.025      | 2.00   |
| `gpt-5-nano`     | 0.05  | 0.005      | 0.40   |
| `gpt-5.1`        | 1.25  | 0.125      | 10.00  |
| `gpt-5.2`        | 1.75  | 0.175      | 14.00  |
| `gpt-5.3-codex`  | 1.75  | 0.175      | 14.00  |
| `gpt-5.4`        | 2.50  | 0.25       | 15.00  |
| `gpt-5.4-mini`   | 0.75  | 0.075      | 4.50   |
| `gpt-5.4-nano`   | 0.20  | 0.02       | 1.25   |
| `gpt-5.5`        | 5.00  | 0.50       | 30.00  |
| `o3`             | 2.00  | 0.50       | 8.00   |
| `o3-mini`        | 1.10  | 0.55       | 4.40   |
| `o4-mini`        | 1.10  | 0.275      | 4.40   |

`gpt-5-codex`, `gpt-5.1-codex`, and `gpt-5.1-codex-max` — all of which appear in Codex transcripts
on this machine — are **not** on OpenAI's current pricing page (only `gpt-5.3-codex` carries a
`-codex` suffix there) and are intentionally left out of the table: they price as "—" (R3) rather
than guessed. Flag this gap in the final report.

## Implementation Units

### U1. Protocol: cost fields and the `tokenUsageCost` feature flag

**Goal:** Add the wire shape for per-row and range-total cost, additive-optional, and a feature
flag gating it.

**Requirements:** R1, R2, R3, R6 (sourcing lives in code comments, not the wire).

**Dependencies:** None.

**Files:**

- `packages/protocol/src/token-usage/rpc-schemas.ts`
- `packages/protocol/src/messages.ts`
- `packages/protocol/src/messages.token-usage.test.ts`

**Approach:**

- `TokenUsageRowSchema` gains `costUsd: z.number().nonnegative().nullable().optional()` — `null`
  means this row's model has no listed price; absent means an old daemon.
- `TokenUsageGetBreakdownResponseSchema`'s payload gains `totalCostUsd:
z.number().nonnegative().nullable().optional()` (sum of priced rows; `null` when disabled) and
  `unpricedTokens: z.number().nonnegative().optional()` (raw token sum across unpriced rows).
- `messages.ts` features object gains `tokenUsageCost: z.boolean().optional()` with a
  `// COMPAT(tokenUsageCost): added in v0.9.x, remove gate after 2027-10-22.` comment next to the
  existing `tokenUsage` flag.
- No `.transform()`/`.catch()`/`.preprocess()` — wire schemas stay pure
  (`docs/protocol-compatibility.md`).

**Patterns to follow:** The existing `weighted`/`responses` fields on `TokenUsageRowSchema` for
field style; the `compactionLedger` flag's COMPAT comment for the new flag.

**Test scenarios:**

- Old-shaped payload (no `costUsd`/`totalCostUsd`/`unpricedTokens`) still parses against the new
  schema (`TokenUsageGetBreakdownResponseSchema.parse(...)` with the fields omitted).
- A payload with `costUsd: null` on a row parses (unpriced-model case).
- `server_info` with `features: { tokenUsage: true }` (no `tokenUsageCost`) still parses; one with
  `tokenUsageCost: true` added parses and round-trips.

**Verification:** `npx vitest run packages/protocol/src/messages.token-usage.test.ts --bail=1`
passes; `npm run typecheck` clean for `packages/protocol`.

---

### U2. Server: the price table module

**Goal:** A pure, testable price lookup independent of the store/service.

**Requirements:** R1, R3.

**Dependencies:** None (reads `normalizeClaudeRuntimeModelId` from the existing manifest module).

**Files:**

- `packages/server/src/server/token-usage/token-usage-pricing.ts` (new)
- `packages/server/src/server/token-usage/token-usage-pricing.test.ts` (new)

**Approach:**

- A header comment states the two sources and the 2026-10-22 "as of" date, plus the KTD-3/KTD-4
  assumptions inline (5-minute cache writes; Haiku 5.5 ≤100K tier).
- `const CLAUDE_PRICES_PER_MTOK: Partial<Record<string, ModelPriceUsd>>` keyed by the canonical
  manifest id (matching `normalizeClaudeRuntimeModelId`'s output), values from the Price Table
  above.
- `const CODEX_PRICES_PER_MTOK: Partial<Record<string, ModelPriceUsd>>` keyed by the exact Codex
  model string, values from the Price Table above.
- `interface ModelPriceUsd { input: number; cacheWrite: number; cacheRead: number; output:
number }` — dollars per million tokens.
- `export function priceTokenUsage(input: { provider: string; model: string; input: number;
cacheWrite: number; cacheRead: number; output: number }): number | null`:
  - `provider === "claude"`: normalize `model` via `normalizeClaudeRuntimeModelId` from
    `../agent/providers/claude/model-manifest.js`; look up in `CLAUDE_PRICES_PER_MTOK`; `null` if
    normalization fails or the id isn't in the table.
  - `provider === "codex"`: exact lookup in `CODEX_PRICES_PER_MTOK`; `null` if absent.
  - any other provider: `null` (no price table for it; never guess).
  - When a price is found: `(price.input _ input + price.cacheWrite _ cacheWrite + price.cacheRead
    - cacheRead + price.output \* output) / 1_000_000`.

**Patterns to follow:** `weighTokenUsage` in `packages/server/src/server/agent/token-rate-tracker.ts`
for the shape of a pure per-category weighting function; its `TOKEN_BURN_WEIGHTS` constant for the
"one table, one lookup function" structure.

**Test scenarios:**

- Happy path: a known Claude model (`claude-opus-5-5`) with nonzero input/cacheWrite/cacheRead/
  output returns the expected dollar amount (hand-computed from the table).
- Happy path: a known Codex model (`gpt-5.3-codex`) returns the expected amount.
- Claude model id needing normalization: `claude-opus-5-20260724` (dated snapshot) and
  `claude-sonnet-5-5[1m]` both price as their canonical model (not `null`).
- Edge case: all-zero counts returns `0`, not `null` (a real response with zero usage still has a
  price, it's just $0).
- Error/unknown path: an unrecognized Claude model (`claude-opus-99`) returns `null`.
- Error/unknown path: an unrecognized Codex model (`gpt-5-codex`, confirmed absent from the
  current OpenAI pricing page) returns `null`.
- Error/unknown path: an unrecognized provider (`"opencode"`) returns `null`.

**Verification:** `npx vitest run packages/server/src/server/token-usage/token-usage-pricing.test.ts --bail=1`
passes.

---

### U3. Server: wire pricing into the store, service, and feature advertisement

**Goal:** Every row the store returns carries `costUsd`; the service's breakdown carries
`totalCostUsd`/`unpricedTokens`; the daemon advertises `tokenUsageCost`.

**Requirements:** R1, R2, R3.

**Dependencies:** U1, U2.

**Files:**

- `packages/server/src/server/token-usage/token-usage-store.ts`
- `packages/server/src/server/token-usage/token-usage-store.test.ts`
- `packages/server/src/server/token-usage/token-usage-service.ts`
- `packages/server/src/server/token-usage/token-usage-service.test.ts`
- `packages/server/src/server/websocket-server.ts`

**Approach:**

- `TokenUsageStore.query()`: alongside the existing `row.weighted = weighTokenUsage(...)` line, add
  `row.costUsd = priceTokenUsage({ provider: row.provider, model: row.model, input: row.input,
cacheWrite: row.cacheWrite, cacheRead: row.cacheRead, output: row.output })`, imported from
  `./token-usage-pricing.js`.
- `TokenUsageService.getBreakdown()`: after `this.store.query(rangeStartMs)` returns `rows`, reduce
  once to build `totalCostUsd` (sum of `costUsd` over rows where it isn't `null`) and
  `unpricedTokens` (sum of `input+cacheWrite+cacheRead+output` over rows where `costUsd === null`).
  Add both to the returned `TokenUsageBreakdown`. The disabled-feature early return keeps
  `totalCostUsd: null`.
- `websocket-server.ts`: next to `...(this.tokenUsage ? { tokenUsage: true } : {})`, add
  `...(this.tokenUsage ? { tokenUsageCost: true } : {})` with its own COMPAT comment — ties the new
  flag to the same underlying service rather than a new constructor option.

**Patterns to follow:** The existing `row.weighted = weighTokenUsage(...)` call site in
`query()` for where the new line goes; the `coverage()` computation in the service for how an
aggregate is built from already-materialized rows.

**Test scenarios:**

- `TokenUsageStore.query()`: a booked Claude row with a known model returns a row with
  `costUsd` matching U2's hand-computed amount.
- `TokenUsageStore.query()`: a booked row with `model: "unknown"` returns `costUsd: null`.
- `TokenUsageService.getBreakdown()`: two rows, one priced one not — `totalCostUsd` sums only the
  priced row; `unpricedTokens` sums the unpriced row's raw token total.
- `TokenUsageService.getBreakdown()`: feature disabled (`isEnabled` false) returns `totalCostUsd:
null`, `unpricedTokens: 0`, matching the existing disabled-path shape for `rows`/`coverage`.
- `websocket-server.ts` / `daemon-e2e/token-usage.e2e.test.ts`: `server_info.features.tokenUsageCost`
  is `true` whenever `tokenUsage` is (extend the existing assertion at line ~72 rather than adding
  a new test file).

**Verification:** `npx vitest run packages/server/src/server/token-usage/token-usage-store.test.ts packages/server/src/server/token-usage/token-usage-service.test.ts --bail=1`
passes; `npm run build:server` then `npm run typecheck` clean.

---

### U4. App: cost display on the Tokens screen

**Goal:** Show cost per model row, per role total, and as a range total, gated on the
`tokenUsageCost` feature, labeled as an API-equivalent estimate.

**Requirements:** R4, R5.

**Dependencies:** U1 (wire shape), U3 (real data) — can be built against U1's types with fixture
data before U3 lands.

**Files:**

- `packages/app/src/token-usage/token-usage-model.ts`
- `packages/app/src/token-usage/token-usage-model.test.ts`
- `packages/app/src/token-usage/tokens-by-model-card.tsx`
- `packages/app/src/token-usage/tokens-by-role-card.tsx`
- `packages/app/src/token-usage/token-usage-view.tsx`
- `packages/app/src/token-usage/token-usage-screen.tsx`
- `packages/app/src/token-usage/token-usage-fixtures.ts`
- `packages/app/src/token-usage/token-usage-content.test.tsx`
- `packages/app/src/i18n/resources/en.ts` (and `ar.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`,
  `pt-BR.ts`, `ru.ts`, `zh-CN.ts`)

**Approach:**

- `token-usage-model.ts`:
  - `export function formatUsd(value: number): string` — `Intl.NumberFormat("en-US", { style:
"currency", currency: "USD" })`, except `0 < value < 0.005` formats as `"<$0.01"` (a nonzero
    cost should never display as indistinguishable from zero). KTD-7: fixed `en-US`, not
    locale-aware.
  - `TokenUsageModelBar` gains `costUsd: number | null; formattedCost: string | null` — summed
    from `row.costUsd` across the rows folded into that bar in `buildTokenUsageModelBars`; `null`
    (and `formattedCost: null`) if any contributing row's `costUsd` is `null`/undefined (a
    provider+model pricing is deterministic, so this only triggers for genuinely unpriced
    models).
  - `TokenUsageRoleTotal` gains the same `costUsd`/`formattedCost` pair, summed in
    `buildTokenUsageRoleTotals`.
  - New `export interface TokenUsageCostSummary { totalCostUsd: number | null; formattedTotal:
string | null; unpricedTokens: number; hasUnpriced: boolean }` and `export function
buildTokenUsageCostSummary(breakdown: Pick<TokenUsageBreakdown, "totalCostUsd" |
"unpricedTokens">): TokenUsageCostSummary` — thin wrapper, no recomputation (the server already
    aggregated it).
- `tokens-by-model-card.tsx`'s `ModelRow`: render `bar.formattedCost` under `bar.formattedTotal`
  in the existing value column (muted, smaller font), or the em dash when `null` — only when the
  cost feature is supported (passed down as a prop, not re-derived per row).
- `tokens-by-role-card.tsx`'s `RoleRow`: same pattern for `entry.formattedCost`.
- `token-usage-view.tsx`: a small cost summary line above `TokensByModelCard`, visible only when
  `costSupported` — `t("tokenUsage.costLabel")` + `formattedTotal` (or the em dash) +
  `t("tokenUsage.costCaption")` as a muted subtitle; when `hasUnpriced`,
  `t("tokenUsage.unpricedFooter", { count: formatCompactTokens(unpricedTokens) })` beneath it.
  `TokenUsageContentProps` gains `costSupported: boolean`.
- `token-usage-screen.tsx`: `const costSupported = useHostFeature(serverId, "tokenUsageCost");`
  passed through to `TokenUsageContent`.
- `token-usage-fixtures.ts`: add `costUsd` to every fixture row (hand-computed from the Price
  Table), `totalCostUsd`/`unpricedTokens` to the breakdown fixtures, and change the Codex model id
  from `"gpt-5-codex"` (unpriced, not on OpenAI's current page) to `"gpt-5.3-codex"` (priced) on
  the two populated Codex rows so the fixture demonstrates both a priced Codex row and the
  existing unpriced `"unknown"` row.
- i18n: add under the existing `tokenUsage` key in every locale file:
  `costLabel: "API-equivalent cost"`, `costCaption: "What this usage would cost at API list
prices — not what a flat-rate subscription bills."`, `unpricedFooter: "{{count}} tokens have no
listed price and aren't included in the total"`. (The bare em dash used for "no price" is a
  placeholder glyph, not prose, and stays unlocalized — same treatment as other dash placeholders
  already in the app.)

**Patterns to follow:** The existing `t("tokenUsage.byModelTitle")` call sites for where the new
keys plug in; `resolveTokenUsageAvailability`'s gate-by-feature shape for `costSupported`;
`formatCompactTokens` for the "compact, three-significant-digit" formatting style `formatUsd`
should feel consistent with (though currency format is different enough to need its own
function).

**Test scenarios:**

- `formatUsd`: `0` -> `"$0.00"`; `0.003` -> `"<$0.01"`; `1.2345` -> `"$1.23"`; `1234.5` ->
  `"$1,234.50"`.
- `buildTokenUsageModelBars`: two rows for the same provider/model, both priced -> bar's
  `costUsd` is the sum, `formattedCost` matches `formatUsd`.
- `buildTokenUsageModelBars`: a provider/model with `costUsd: null` on its row -> bar's `costUsd`
  and `formattedCost` are both `null`.
- `buildTokenUsageRoleTotals`: same priced/unpriced behavior, summed per role.
- `buildTokenUsageCostSummary`: `totalCostUsd: 12.34, unpricedTokens: 0` -> `hasUnpriced: false`,
  `formattedTotal: "$12.34"`; `unpricedTokens: 500` -> `hasUnpriced: true`.
- Integration (covers the callback from row data to rendered text —
  `token-usage-content.test.tsx`): with `costSupported: true` and the fixture breakdown, the cost
  summary line and at least one model row's cost text render; with `costSupported: false`, no cost
  text renders anywhere on the screen (old-daemon case).
- Integration: the unpriced footer renders only when `unpricedTokens > 0` in the fixture.

**Verification:** `npx vitest run packages/app/src/token-usage/token-usage-model.test.ts packages/app/src/token-usage/token-usage-content.test.tsx --bail=1`
passes; `npm run typecheck` and `npm run lint -- packages/app/src/token-usage` clean. Manually
confirmed in a running dev app that the cost summary and row costs render and wrap sensibly at
phone width and desktop width (Rapid-mode note: this manual check is deferred to the final report
rather than blocking the commit, per the session's rapid-mode framing — flagged explicitly as
unverified rather than claimed).

---

### U5. Docs: integrate cost into `docs/token-usage.md`

**Goal:** `docs/token-usage.md` documents the price table's existence, sourcing, and the two
pricing assumptions, in the doc's existing voice (plain, short, integrate don't append).

**Requirements:** R6.

**Dependencies:** U1-U3 (describes the shipped shape, not a plan).

**Files:**

- `docs/token-usage.md`

**Approach:** Add a new `## Cost` section after "## The RPC" (before "## Checking it against the
transcripts"), covering: where the price table lives
(`packages/server/src/server/token-usage/token-usage-pricing.ts`), that it's a static,
code-reviewed table with an "as of" date rather than a live price feed, the two assumptions
(5-minute cache-write rate; Haiku 5.5's ≤100K-token tier) and why they can't be resolved from the
stored buckets, that an unpriced model contributes to `unpricedTokens` rather than a silent zero,
and the new `tokenUsageCost` feature gate. One short addition to the existing "## The RPC"
section's field list (new fields named, not re-described). Test expectation: none — doc-only
change.

**Verification:** Read-through: every claim in the new section matches the code written in U1-U3.

## Scope Boundaries

**In scope:** Server-side price table and cost computation; new optional protocol fields and
feature flag; Tokens screen display (row, role, range total); docs.

**Deferred to Follow-Up Work:**

- Live/remote price feeds, or any network call to fetch current prices — the table is static and
  reviewed by hand, matching how `weighTokenUsage`'s burn-weight table already works.
- Per-request prompt-length tracking to resolve Haiku 5.5's two-tier pricing exactly (KTD-4) —
  would need a new field on the stored hourly buckets, out of scope for this change.
- Splitting `cacheWrite` into 5-minute/1-hour sub-buckets at the transcript-parser level (KTD-3) —
  same shape of change, bigger than this plan's footprint.
- A cost-based alternative to the existing `weighted`/`raw` unit toggle (e.g., sorting bars by
  cost instead of weighted tokens) — the brief asks for cost shown alongside the existing units,
  not a new primary sort axis.
- Pricing `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max` — not on OpenAI's current pricing
  page; add them once OpenAI publishes rates rather than guessing now.

**Outside this change's identity:** Any notion of real billing, budgets, or spend alerts tied to
this dollar figure — `docs/token-usage.md` already states token usage "reads and reports. It
never pushes, budgets or steers," and this change does not alter that.

## Verification Contract

- `npx vitest run` on every test file touched in U1-U4 (listed per-unit above), run individually
  per the repo's "never run the full suite" rule.
- `npm run typecheck` after U1 (rebuild protocol: `npm run build:client`), after U3 (rebuild
  server: `npm run build:server`), and after U4.
- `npm run lint` and `npm run format` before committing.
- Old-app/new-daemon: a payload with the new fields present but an old app's schema (without them)
  still parses — covered by U1's round-trip test using the _old_ shape as input to the _new_
  schema (forward compatibility is the direction this repo's schemas must hold either way; the
  reverse — new app, old daemon — is what `costSupported`/`tokenUsageCost` governs at the UI
  layer, covered by U4's integration test).
- New-app/old-daemon: `costSupported: false` hides all cost UI — covered by U4's integration test.

## Definition of Done

- All five units implemented, typechecked, linted, formatted.
- Test files listed above pass.
- `docs/token-usage.md` updated.
- Changes committed locally (not pushed, no PR — per this session's instructions).
