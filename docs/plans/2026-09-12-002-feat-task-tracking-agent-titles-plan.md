# Agent titles that track the current task

Status: design complete, ready for implementation.
Provenance: read-only design agent (Sonnet 5) on 2026-09-11; verified against the tree at `84e1397d2`.

## User ask

Make the "name" of each agent something that reflects what it's currently tasked with, not just the first few words the user typed at creation.

## What exists today

- **Creation-time title** (`packages/server/src/server/agent/create-agent-title.ts:1-46`): `resolveCreateAgentTitles` picks the caller's explicit `title` or falls back to `deriveInitialAgentTitle` — the first non-empty prompt line clamped to 60 chars. Runs once; nothing revisits it.
- **Explicit-vs-derived is already conflated before storage**: `buildMcpSessionConfig` (`create-agent/create.ts:419-434`) writes only `provisionalTitle` into `config.title`, and `resolveInitialPersistedTitle` (`agent-manager.ts:3789-3803`) treats any non-empty `config.title` as explicit. No stored signal distinguishes the two.
- **Structured generation** (`structured-generation-providers.ts`): fallback chain = configured `metadataGeneration.providers` → hardcoded cheap defaults (Haiku, gpt-5.4-mini/low, minimax-m3, nemotron-3-super) → the agent's own provider. `generateStructuredAgentResponseWithFallback` (`agent-response-loop.ts:398`) runs it with schema validation/retries. `worktree-branch-name-generator.ts:124-129` is the template: `persistSession: false`, `agentConfigOverrides: { internal: true }` — a throwaway side-channel session that never touches the target agent's context.
- **Config**: `AgentMetadataGenerationSchema` (`persisted-config.ts:166-178`) is `.strict()` with only `providers`; the wire twin `MutableMetadataGenerationConfigSchema` (`protocol/messages.ts:136-140`) is `.passthrough()` — additive fields are free.
- **Title propagation already works live, zero protocol changes**: `AgentSnapshotPayloadSchema.title` (`messages.ts:877`) rides every agent-state broadcast; `AgentManager.setTitle()` (`agent-manager.ts:1956-1972`) does `persistSnapshot → emitState`; `Session.enrichAgentPayload()` (`session.ts:1836-1841`) re-reads the title from storage on every dispatch.

## Design decisions

- **WHEN**: on the running→idle transition, hooked once in `AgentManager.emitState()` (`agent-manager.ts:4711`) — the single choke point for every state broadcast across providers. Do NOT reuse `checkAndSetAttention()`'s transition detection: its early-return on unread attention (`:4758-4761`) would skip turn 2 if turn 1's attention is uncleared. Capture `previousStatus` before calling it and check the transition independently; invoke a new injected `onAgentTurnFinished` callback (skip `agent.internal`).
- **Cheap change gate — no LLM call unless there's a new user message**: track in-memory (precedent: `lastActivitySummary`, `agent-manager.ts:409-415`) the last user-message text a title was generated from; compare against the latest `user_message` in `agentManager.getTimeline(id)` (in-memory, no I/O). Plus a per-agent debounce (default 4000ms) collapsing rapid follow-ups.
- **Manual-title protection scoped to the rename action, not creation**: titles set at creation (explicit param or first-line guess) are both refreshable; only `AgentManager.setTitle` / `writeStoredMetadata` title patches (the `update_agent` MCP tool and app rename UI) set `titleManuallySet: true` and are protected. Requires no changes to `create-agent/create.ts` or `AgentSessionConfig`.
- **HOW**: reuse the branch-name generator's shape — `buildMetadataPrompt({ configKey: "title" })` (project-level `paseo.json` title-style overrides apply for free), `resolveStructuredGenerationProviders`, `generateStructuredAgentResponseWithFallback` with `persistSession: false, agentConfigOverrides: { internal: true }`. Schema `{ title: string }` (min 1, max 80). Prompt: given the CURRENT title and NEWEST user instruction — keep the title for small refinements/corrections/continuations, replace it when the task materially shifts.
- **Failure behavior**: identical to `generateBranchNameFromFirstAgentContext` (`worktree-branch-name-generator.ts:135-144`) — try/catch, log `StructuredAgentFallbackError`/`StructuredAgentResponseError` branches, swallow, no-op. Never throws into turn completion. `maxRetries: 1`.

## Implementation plan

1. **`agent-storage.ts`** — add `titleManuallySet: z.boolean().optional()` to `STORED_AGENT_SCHEMA` (~:44-72); in `applySnapshot()` (:240-264) add a `hasOwnProperty`-style override check (pattern of `hasTitleOverride`, :245-246), thread through `toStoredAgentRecord`, preserving `existing?.titleManuallySet` when not overridden; widen the `options` type.
2. **`agent-projections.ts`** — `titleManuallySet?: boolean` on `ProjectionOptions` (:25-29); emit it in `toStoredAgentRecord()` (:63-98) mirroring `internal` (:95).
3. **`agent-manager.ts`** —
   - `persistSnapshot` options (:3805-3808) accept `titleManuallySet?: boolean`, pass to `registry.applySnapshot`.
   - `setTitle()` (:1956-1972) passes `titleManuallySet: true`.
   - `writeStoredMetadata()` (:1996-2014): when `patch.title` present, set `titleManuallySet: true` (sole caller `updateAgentMetadataUnlocked` :2229 is the offline-rename path — always manual).
   - New `applyGeneratedTitle(agentId, title): Promise<boolean>` — trims, re-checks `record.titleManuallySet` and unchanged-title at WRITE time (so a rename racing an in-flight refresh always wins), `touchUpdatedAt` + `persistSnapshot` (omitting `titleManuallySet` → preserved) + `emitState({persist:false})`.
   - `AgentManagerOptions.onAgentTurnFinished?: (params: { agentId: string; cwd: string }) => void` (pattern of `onWorkspaceStateMayHaveChanged`); fire in `emitState()` on `previousStatus === "running" && lifecycle === "idle" && !agent.internal`.
4. **`create-agent-title.ts`** — add `getLatestUserMessageText(items): string | null` (last `user_message`, trimmed; sibling of `getFirstUserMessageTextFromRows`, `agent-manager.ts:668-679`, but over live `AgentTimelineItem[]`).
5. **`structured-generation-providers.ts`** — extend `StructuredGenerationDaemonConfig.metadataGeneration` (:10-17) with `titleTracking?: { enabled?: boolean }`.
6. **New `packages/server/src/server/agent-title-tracker.ts`** (sibling to `workspace-auto-name.ts`): `AgentTitleTracker` with `scheduleRefresh({agentId, cwd})` (per-agent debounce Map, default 4000ms) and private `refresh()` — config gate (`titleTracking?.enabled !== false`, default-on) → skip when `titleManuallySet` / `archivedAt` / no live agent / latest user message unchanged → generate → `applyGeneratedTitle` → swallow errors. Injectable `deps.generateStructuredAgentResponseWithFallback` for tests. `AgentTitleRefreshSchema = z.object({ title: z.string().min(1).max(80) })`.
7. **`persisted-config.ts`** — `AgentMetadataGenerationSchema` gains `titleTracking: z.object({ enabled: z.boolean().optional() }).strict().optional()`.
8. **`protocol/messages.ts`** — `MutableMetadataGenerationConfigSchema` gains the same shape as `.passthrough().optional()`. Additive optional field; no COMPAT tag needed.
9. **`daemon-config-store.ts` `mergeMutableAgentPatch` (:601-628)** — DEFERRED this pass (file-config path is enough; UI toggle is a ~10-line mechanical follow-up).
10. **`bootstrap.ts`** — break the construction cycle with a reassignable closure: `let handleAgentTurnFinished = () => {}` before `new AgentManager({ onAgentTurnFinished: (p) => handleAgentTurnFinished(p) })` (:922-935); construct the tracker near `workspaceAutoName` (:1073-1088) with `readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration })`, then point the closure at `tracker.scheduleRefresh`.

## Tests

- `agent-title-tracker.test.ts` (injected-generator style of `worktree-branch-name-generator.test.ts`): disabled-config skip; `titleManuallySet` skip; unchanged-message skip (assert zero generator calls); debounce collapses two rapid schedules; success applies via `applyGeneratedTitle`; errors swallowed and logged.
- `agent-manager.test.ts` additions: `setTitle` marks `titleManuallySet`; `applyGeneratedTitle` no-ops on manual/unchanged; `onAgentTurnFinished` fires exactly once on running→idle, not idle→idle, not for internal agents, and fires on turn 2 with turn 1's attention still unread.
- `create-agent-title.test.ts` (new): `getLatestUserMessageText` last-match behavior + null on empty.
