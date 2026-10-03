---
title: Orchestration Visibility and Budget Overview - Plan
type: feat
date: 2026-09-11
topic: orchestration-visibility
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Orchestration Visibility and Budget Overview - Plan

## Goal Capsule

- **Objective:** An operator running a leader with many pool-routed subagents can see, in one live surface: the full recursive leader/subagent tree (nothing hidden while running), what each agent is doing right now, which needs attention, and how much budget remains on each account in use — plus one-tap cleanup of finished workers.
- **Authority:** This plan; repo conventions (CLAUDE.md, docs/design.md, docs/protocol-compatibility.md). Builds on the account-pool branch (`multi-account-orchestrator`).
- **Stop conditions:** surface if the additive protocol field cannot stay display-only optional, or if the panel contract cannot host a live tree without layout-store violations.
- **Tail ownership:** executor commits/pushes this branch; changes ride the existing PR #1.

---

## Product Contract

### Summary

A new **Orchestration** workspace panel shows an account-budget strip (one compact usage row per Claude account the tree uses) above a recursive, live leader/subagent tree with real status, attention, per-agent "what it's doing" text, and open/archive/detach/archive-finished actions. A small additive protocol field carries each agent's last-activity summary so rows stay current without timeline subscriptions, and the existing subagents track stops suppressing attention.

### Problem Frame

Subagents are stored and streamed but structurally invisible: they never auto-open as tabs, the composer track shows only direct children as icon pills (attention hardcoded off, no activity/model/usage), children vanish from the track while still running (cascade-archive, cross-workspace/open-tab detach, local provider-row hiding), and finished workers accumulate forever unless manually archived. Budget lives only in a Settings page with no connection to which agents burn which account.

### Requirements

**Tree visibility**

- R1. A workspace-scoped Orchestration panel lists every root agent and its full recursive descendant tree (assembled from `paseo.parent-agent-id`), including children living in other workspaces; non-archived agents never drop out while running.
- R2. Each row shows: status dot (shared mapping), real `requiresAttention` badge, title, provider icon + account label, model, relative last-update time, and a one-line current-activity summary when available.
- R3. Attention rolls up: a node with any descendant requiring attention shows a rollup indicator; the panel's tab affordance reflects tree-wide attention.
- R4. Row actions: open (respecting the open-location preference), archive, detach; a tree-level "Archive finished" bulk action mirrors the track's.

**Freshness**

- R5. Rows update from the existing push snapshot stream (no polling for agent state); an additive optional `lastActivitySummary` field on agent snapshots carries the current-activity line, computed O(1) server-side from the latest timeline item and projected like `lastUsage`.
- R6. The existing subagents track renders real `requiresAttention` (bug fix) and the activity summary as its subtitle when present.

**Budget overview**

- R7. The panel's top strip shows one compact row per account (provider entry) used by any agent in the tree: label from the providers snapshot, correct icon (serverId-aware), the 5-hour and weekly windows with used %, tone, and reset time.
- R8. The strip refreshes on an interval (~75s; server caches 5 min so this is cheap) plus manual refresh; it reuses the existing usage components rather than new meters.

**Entry points**

- R9. The panel opens from a composer track-bar affordance on any agent with children and from a Command Center action; it is a normal panel-registry tab kind (Explorer hosting deferred).

### Key Decisions

- **Core panel, not a plugin surface.** Plugins can read usage but are denied the workspace-layout store and tab routing the tree needs. (Research-verified.)
- **Panel-registry tab kind** (exemplar: provider-subagent-panel) over Explorer sidebar or a new screen — smallest contract that gives desktop pane + compact stack for free; Explorer hosting can come later.
- **Additive optional protocol field, no feature flag** — display-only, degrades to absent on old daemons per docs/protocol-compatibility.md's additive contract; follows the `lastUsage`/attention-triple precedent.
- **No archive-semantics changes.** Cleanup improves via surfaced bulk actions, not new lifecycle behavior; detached children (parent link cleared) are out of scope v1.
- **Agent state stays push; usage stays poll** — matching the existing architecture (no new push channel).

### Scope Boundaries

Deferred: Explorer-sidebar hosting; cross-host fleet aggregation in the panel (workspace-scoped v1; the flat AgentList remains the cross-host view); recovering detached children; per-agent token-spend rollups; auto-archive policy changes; upstreaming.

---

## Planning Contract

**Target repo:** this fork (branch `multi-account-orchestrator`). All app/server/protocol work is core (no plugin changes).

### Key Technical Decisions

- KTD1. `lastActivitySummary?: string` added to `AgentSnapshotPayloadSchema` (packages/protocol/src/messages.ts:854-883) and `AgentListItemPayloadSchema` (:887-906); computed on `ManagedAgent` at timeline-dispatch time from the latest item (reuse activity-curator.ts's per-item folding, not the tail scan), projected in `toAgentPayload`/`buildStoredAgentPayload`/`toAgentListItemPayload` (agent-projections.ts:100-160,194-249,251-272) like `lastUsage`; client: `normalizeAgentSnapshot`/`projectAgentSnapshot` (agent-snapshots.ts:60-138) + `Agent` type (session-store.ts:70-102). Wire schemas stay pure.
- KTD2. Tree assembly is client-side from the ambient store: `parentAgentId` is already derived from labels (agent-snapshots.ts:101); a new selector builds roots→descendants across workspaces (roots via the `isWorkspaceRootAgent` predicate family, agent-visibility.ts:45-48) with attention rollup. No new RPCs.
- KTD3. Budget strip joins on `agent.provider === usage.providerId === ProviderSnapshotEntry.provider` (verified id family); reuses `ProviderUsageWindowBar` and `ProviderUsageCard compact` with serverId passed for icons (fixing card.tsx:68's missing serverId in the new call path only); a `useProviderUsage` variant gains `refetchInterval`.
- KTD4. Panel = `definePanel("orchestration", ...)` + `registerPanel` (register-panels.ts:14,28 exemplar); open-location preference reuses the existing `subagents` entry semantics; row visuals follow docs/design.md §12/§13 (status dots via `getStatusDotColor`, hover `isHovered || isNative || isCompact`, no new colors).
- KTD5. Track fix: `buildSubagentRowPresentationData` (track-presentation.ts:41-44) passes through `row.requiresAttention` and uses `lastActivitySummary` as Paseo-row subtitle.

### Implementation Units

### V1. Fork: lastActivitySummary end to end

- **Goal:** Snapshots carry a live one-line activity summary.
- **Files:** packages/protocol/src/messages.ts; packages/server/src/server/agent/activity-curator.ts (extract single-item summarizer); packages/server/src/server/agent/agent-manager.ts (set on timeline dispatch + emitState); packages/server/src/server/agent/agent-projections.ts (+ its tests); packages/app/src/utils/agent-snapshots.ts; packages/app/src/stores/session-store.ts.
- **Test scenarios:** tool-call item → "Tool: <summary>" style line; assistant text → truncated text; projection includes field only when set; list-item projection carries it; old-payload (field absent) normalizes to undefined; schema stays additive (existing wire tests untouched).
- **Verification:** targeted vitest (projections, curator, agent-snapshots); `npm run build:client && npm run typecheck && npm run lint`.

### V2. App: orchestration data layer + track fixes

- **Goal:** Tree selector with rollup, plus the track bug fix.
- **Dependencies:** V1 (Agent type field).
- **Files:** packages/app/src/orchestration/select.ts (+test) — roots, recursive children across workspaces, attention rollup, finished detection (reuse archive-finished.ts predicates); packages/app/src/subagents/track-presentation.ts (+test).
- **Test scenarios:** grandchildren nest; cross-workspace child stays in tree; archived child excluded; rollup true when any descendant requiresAttention; track row now carries real requiresAttention and activity subtitle.

### V3. App: account budget strip

- **Goal:** Compact per-account usage rows for a given set of provider ids.
- **Dependencies:** none (parallel with V2).
- **Files:** packages/app/src/orchestration/account-budget-strip.tsx (+test where practical); packages/app/src/provider-usage/use-provider-usage.ts (optional refetchInterval param, default unchanged); reuse window-bar/card.
- **Test scenarios:** renders one row per distinct provider id with snapshot label; unavailable account renders its unavailable state; interval passed through to the query.

### V4. App: orchestration panel + entry points

- **Goal:** The panel itself plus how you reach it.
- **Dependencies:** V2, V3.
- **Files:** packages/app/src/panels/orchestration-panel.tsx; packages/app/src/panels/register-panels.ts; packages/app/src/panels/agent-tracks.tsx (track-bar affordance); command-center registration; workspace-tab target type additions as the registry requires.
- **Test scenarios:** panel lists tree rows with actions wired (open/archive/detach callbacks fire store/RPC paths); archive-finished bulk invokes the shared helper; attention badge on the affordance when rollup true; compact form factor renders (no hover-only controls on native).
- **Verification:** targeted vitest; `npm run typecheck && npm run lint`; manual QA pass on desktop web (dev daemon) with a live leader+children tree — screenshot for the PR.

### V5. Verification tail

- **Goal:** Suites green, PR updated with walkthrough + screenshots.
- **Dependencies:** V1-V4.
- **Verification contract:** `npm run build:client && npm run typecheck`; `npm run lint`; targeted vitest per changed file; existing plugin/routing e2e untouched and green; fork CI on push.

## Definition of Done

- All five units landed on `multi-account-orchestrator`, pushed, CI green.
- Live proof on the dev daemon: a leader with ≥2 pool-routed children shows the full tree with real statuses, activity lines update as children work, budget strip shows both accounts, archive-finished clears idle children.
- PR #1 walkthrough refreshed; no progress notes in this plan file.
