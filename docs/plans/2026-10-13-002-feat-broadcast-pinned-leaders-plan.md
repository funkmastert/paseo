---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# feat: Broadcast a prompt to every pinned leader agent

## Summary

Add a button next to the sidebar's pinned-grid button that opens a composer for sending one
prompt to every agent the pinned area actually shows — one target per pinned workspace, the exact
agent its grid cell displays — at once: "send to all my pinned leaders." Sending reuses the exact
client path the ordinary composer uses (`dispatchComposerAgentMessage`), one request per target
agent, in parallel, with the same queue/steer/interrupt semantics a typed message already gets. No
protocol change.

## Problem Frame

Tyler runs many pinned leader agents in parallel and currently has to open each one and retype
the same prompt. He wants one button, next to the existing pinned-grid button, that opens a small
composer, shows every pinned leader with a checkbox (checked by default), and sends his prompt to
all of them with one action.

## Requirements

- R1. A button lives in the sidebar's pinned-section header, next to the existing grid button,
  visible only when at least one pinned leader agent qualifies as a target.
- R2. Targets are exactly one per pinned workspace (`workspace.pinnedAt`): the same agent that
  workspace's pinned-grid cell shows (`pinned-grid/resolve-pinned-agent.ts`'s
  `pickPinnedWorkspaceAgentId`) — its most-recently-active, non-archived root agent, or the live
  end of that conversation when account failover retired the agent Tyler was looking at. A pinned
  child agent is never itself a target, and a workspace with several root agents contributes only
  the one the grid already shows — never every qualifying agent, which would message a stale
  leader he isn't looking at.
- R3. The composer is a popover on wide screens and a bottom sheet on compact ones, holding a
  multi-line text box, a deselectable target checklist (title + status, all checked by default),
  and a "Send to N agents" button disabled when the text is empty or no target is checked.
  Enter-to-send matches the regular composer.
- R4. Sending dispatches one request per selected agent, in parallel, through the same client path
  the agent's own composer uses (`dispatchComposerAgentMessage`), so a running agent gets its
  configured queue/steer/interrupt behavior exactly as if the text had been typed there directly.
- R5. On full success: toast "Sent to N agents", composer closes. On partial failure: toast names
  the failed agents, the composer stays open with the text preserved so Tyler can retry.
- R6. Works on iOS, Android, web, and Electron desktop.

## Key Technical Decisions

- **KTD1 — Reuse `dispatchComposerAgentMessage`, not `broadcast_agent_prompt`.** The server tool
  in `packages/server/src/server/agent/tools/coordination-tools.ts` is for agent-to-agent
  coordination (label-selected, no paid turn for most targets) — a different delivery model from
  "the user typed this into N composers." The client already owns the real semantics
  (`packages/app/src/composer/actions.ts`'s `dispatchComposerAgentMessage`, wired in
  `composer/index.tsx`): it builds the optimistic user message, resolves
  `activeTurnBehavior`/`activeTurnId` from the per-agent turn setting, and calls
  `client.sendAgentMessage`. Calling it once per target, in parallel, is "exactly what typing the
  prompt into each agent's own composer would do" — no new RPC, no protocol change.
- **KTD2 — Target selection reuses `pickPinnedWorkspaceAgentId` directly, no second picker.**
  Targets must match what the pinned area shows (R2): `docs/pinned-grid.md` — "the grid shows one
  chat per pin: the most recently active, non-archived root agent, or the live end of its
  conversation when account failover retired it." Messaging every root agent in a pinned workspace
  would reach a stale leader, and messaging a failover-retired agent would reach a conversation
  Tyler can no longer see. `selectBroadcastPinnedLeaderTargets` scopes each pinned workspace's
  agents by server, calls `pickPinnedWorkspaceAgentId` per workspace, and looks up the returned
  live-end id for display fields — the picker's own root/archived/failover logic is the only
  selection logic; this feature adds none of its own.
- **KTD3 — Popover/sheet shell is the menu engine, not `AdaptiveModalSheet`.** The brief asks for
  "a popover on desktop and a sheet on compact" — `docs/menus.md` defines exactly those two
  presentations (`MenuRoot`/`MenuSurface`, anchored popover wide / bottom sheet compact) and
  already supports a page that takes input (`hoverIntent: false`) plus an independent-toggle
  checklist (`MenuItem selected closeOnSelect={false}`), demonstrated end-to-end in
  `packages/app/src/workspace-labels/picker.tsx`. `AdaptiveModalSheet` (the schedule form's shell)
  is a centered dialog on desktop, not an anchored popover, so it doesn't fit this brief's wording.
  The one gap: `MenuTextField` is single-line, so the prompt box is a plain `AdaptiveTextInput`
  with `multiline` embedded directly in the page content (same inset rail,
  `menuRowContentInset`), not `MenuTextField`.
- **KTD4 — Plain-TS form model, per `docs/forms.md`.** Draft text + checked-target-ids live in a
  model object (`createBroadcastPinnedComposerModel`), constructed once per popover open
  (`useState(() => ...)`, never `useMemo` keyed on live data), exposing `subscribe`/`snapshot` for
  `useSyncExternalStore`. Avoids the "live data reconstructs the model and wipes in-progress text"
  bug class the forms doc calls out.
- **KTD5 — No protocol change.** Everything routes through the existing `sendAgentMessage` client
  RPC already used by every composer; `server_info.features` gating does not apply.

## High-Level Technical Design

```
PinnedSectionHeader (sidebar-workspace-list.tsx)
 ├─ ToolbarButton (existing "open grid")
 └─ BroadcastPinnedButton (new)              -- rendered only when targets.length > 0
     ├─ useBroadcastPinnedTargets()          -- useSidebarModel + useAggregatedAgents
     │    -> selectBroadcastPinnedLeaderTargets(pinnedChats, agents)
     │         -> per workspace: pickPinnedWorkspaceAgentId (pinned-grid/resolve-pinned-agent.ts)
     ├─ DropdownMenu (menu engine)
     │    ├─ DropdownMenuTrigger = ToolbarButton icon
     │    └─ DropdownMenuContent (custom page, hoverIntent n/a — single root page)
     │         ├─ AdaptiveTextInput (multiline)
     │         ├─ target rows: MenuItem selected={checked} closeOnSelect={false}
     │         └─ Send MenuItem (disabled per model.canSend)
     └─ onSend(text, targetIds)
          -> sendBroadcastPinnedPrompt({ targets, text, ... })
               -> Promise.allSettled(targets.map(dispatchComposerAgentMessage(...)))
               -> toast.show / toast.error
```

## Scope Boundaries

### Deferred to Follow-Up Work

- Attachments/images in the broadcast composer (brief only asks for a text box).
- Any new RPC or `server_info.features` gate (explicitly out of scope per the brief — reuse the
  existing send path).

### Out of scope

- `packages/app/src/agent-stream/` — another worker is building a sticky-last-prompt feature
  there in parallel; this plan touches nothing under that path.

---

## Implementation Units

### U1. Target selection: pure selector over `pickPinnedWorkspaceAgentId` + hook

**Goal:** Resolve "the agent each pinned cell shows" per R2, as a pure function plus a thin React
hook — one target per pinned workspace, reusing the grid's own picker rather than a second one.

**Requirements:** R1, R2

**Dependencies:** none

**Files:**

- `packages/app/src/broadcast-pinned/broadcast-pinned-targets.ts` (new)
- `packages/app/src/broadcast-pinned/broadcast-pinned-targets.test.ts` (new)
- `packages/app/src/broadcast-pinned/use-broadcast-pinned-targets.ts` (new)

**Approach:**

- `selectBroadcastPinnedLeaderTargets(input: { pinnedChats: readonly {serverId, workspaceId, name}[]; agents: readonly BroadcastPinnedAgentCandidate[] }): BroadcastPinnedTarget[]`
  — pure. `BroadcastPinnedAgentCandidate` is `Pick<Agent, "id" | "serverId" | "workspaceId" |
"parentAgentId" | "archivedAt" | "lastActivityAt" | "createdAt" | "labels" | "status" | "title">`
  (the extra recency/label fields are what `pickPinnedWorkspaceAgentId` itself needs). For each
  pinned workspace: group `agents` by `serverId`, call
  `pickPinnedWorkspaceAgentId({ agents: thatServersAgents, workspaceId })` (imported from
  `pinned-grid/resolve-pinned-agent.ts`), and look up the returned live-end agent id in the full
  `agents` list for `title`/`status`. A workspace the picker returns `null` for (no live agent)
  contributes no target. `BroadcastPinnedTarget = { id: string; serverId: string; workspaceId:
string; workspaceName: string; label: string; status: AgentLifecycleStatus }`; `label` is the
  agent's `title?.trim() || "Untitled agent"`.
- `useBroadcastPinnedTargets()`: `useSidebarModel().pinnedGroups.pinnedChats` +
  `useAggregatedAgents()`, mirrors `use-ask-jev-pinned-agents.ts`'s wiring (no per-server
  scoping — scoping happens inside the selector, per pinned workspace). Returns `{ targets,
hasTargets }`.

**Patterns to follow:** `packages/app/src/pinned-grid/resolve-pinned-agent.ts`
(`pickPinnedWorkspaceAgentId` — call it, don't reimplement it),
`packages/app/src/pinned-grid/pinned-grid-cell.tsx` (how a caller scopes agents to one server
before calling the picker), `packages/app/src/ask-jev/use-ask-jev-pinned-agents.ts` (the
`useSidebarModel`/`useAggregatedAgents` hook-wiring shape).

**Test scenarios:**

- Pinned workspace, single root, non-archived agent -> included, with the expected label/status.
- A pinned workspace with two independent root agents -> only the one
  `pickPinnedWorkspaceAgentId` picks (the most recently active) is a target — not both.
- An agent account failover retired, with a live successor in the same workspace -> the
  successor is the target, not the retired handle.
- Agent with `parentAgentId` set (a child) -> excluded even though its workspace is pinned.
- Root agent with `archivedAt` set, no other live agent in the workspace -> excluded.
- A closed-but-not-archived agent -> still a target, matching what the grid cell shows (closed
  is not a selection criterion — the picker doesn't treat it as one, and neither does this).
- Workspace not present in `pinnedChats` -> its agents excluded.
- Two pinned workspaces on different servers -> one target per workspace, correctly scoped.
- Agent whose `title` is null/blank -> label falls back to "Untitled agent".
- Empty `pinnedChats` or empty `agents` -> empty result, no throw.

**Verification:** `selectBroadcastPinnedLeaderTargets` returns exactly the expected target set for
each fixture above; `npx vitest run` on the new test file is green.

---

### U2. Send fan-out: parallel dispatch + partial-failure result

**Goal:** Send one prompt to a set of targets using the same client path as the ordinary
composer, in parallel, collecting per-target success/failure (R4, R5).

**Requirements:** R4, R5

**Dependencies:** U1 (consumes `BroadcastPinnedTarget`)

**Files:**

- `packages/app/src/broadcast-pinned/broadcast-pinned-send.ts` (new)
- `packages/app/src/broadcast-pinned/broadcast-pinned-send.test.ts` (new)

**Approach:**

- `sendBroadcastPinnedPrompt(input: { targets: BroadcastPinnedTarget[]; text: string; getClient:
(serverId: string) => ComposerSendClient | null; resolveActiveTurn: (target) => {
behavior: ActiveTurnBehavior; turnId?: string }; makeSubmission: (serverId: string) =>
MessageSubmissionWriter }): Promise<BroadcastSendResult>` where
  `BroadcastSendResult = { succeeded: string[]; failed: { target: BroadcastPinnedTarget; error:
string }[] }`.
- For each target, call `dispatchComposerAgentMessage` (from `composer/actions.ts`) with
  `attachments: []`, `encodeImages: async () => []`, the resolved client/submission/activeTurn
  inputs. Use `Promise.allSettled` so one rejection never cancels the others — this is the
  partial-failure contract.
- The caller (U3) supplies `getClient` via `getHostRuntimeStore().getClient(serverId)`,
  `makeSubmission` via `createMessageSubmissionWriter(serverId)`, and `resolveActiveTurn` via
  `toActiveTurnBehavior(appSettings.sendBehavior)` plus, when steering, the target's own
  `selectAgentTurnPresentation(sessions[serverId], target.id).turnId` — the same two calls
  `composer/index.tsx`'s `sendAgentMessageRef` effect already makes per send (see
  `packages/app/src/composer/index.tsx:1471-1500`). Injecting them as plain callbacks keeps this
  function host-free and unit-testable.

**Patterns to follow:** `packages/app/src/composer/actions.ts` (`dispatchComposerAgentMessage`),
`packages/app/src/composer/index.tsx:1471-1500` (activeTurnBehavior/activeTurnId resolution),
`packages/app/src/runtime/host-runtime.test.ts` (fake client shape for tests).

**Test scenarios:**

- All targets succeed -> `succeeded` has every target id, `failed` is empty.
- One target's `getClient` returns a client whose `sendAgentMessage` rejects -> that target lands
  in `failed` with its error message, the other targets still land in `succeeded` (partial
  failure doesn't cancel siblings).
- Empty `targets` -> resolves immediately to `{ succeeded: [], failed: [] }` without calling any
  client.
- A target with `getClient` returning `null` (host disconnected) -> counted as failed, not thrown.
- Dispatch is concurrent, not sequential: using controlled promises (pattern from
  `host-runtime.test.ts`), assert a second target's send is issued before the first one's promise
  resolves.
- `activeTurnBehavior`/`activeTurnId` passed through to `dispatchComposerAgentMessage` match what
  `resolveActiveTurn` returned for that specific target (steer vs interrupt, with/without turnId).

**Verification:** `npx vitest run` on the new test file green; fan-out never throws synchronously
for any input combination above.

---

### U3. Composer UI: popover/sheet, checklist, send button

**Goal:** The user-facing composer (R3), wired to U1's targets and U2's send, with toast feedback
(R5) and the sidebar entry point (R1).

**Requirements:** R1, R3, R5, R6

**Dependencies:** U1, U2

**Files:**

- `packages/app/src/broadcast-pinned/broadcast-pinned-composer-model.ts` (new) — plain TS model
- `packages/app/src/broadcast-pinned/broadcast-pinned-composer-model.test.ts` (new)
- `packages/app/src/broadcast-pinned/broadcast-pinned-button.tsx` (new) — trigger + menu wiring
- `packages/app/src/broadcast-pinned/broadcast-pinned-button.browser.test.tsx` (new)
- `packages/app/src/components/sidebar/pinned-section-header.tsx` (modify — render the new button)
- `packages/app/src/components/sidebar-workspace-list.tsx` (modify — wire `useBroadcastPinnedTargets`/send into the header, mirroring `handleOpenPinnedGrid`)
- `packages/app/src/i18n/resources/en.ts` (+ other locale files — modify)

**Approach:**

- `broadcast-pinned-composer-model.ts`: `createBroadcastPinnedComposerModel(targets)` holding
  `{ text: string; checked: Set<string> }` (checked initialized to every target id),
  commands `setText`, `toggleTarget(id)`, derived `canSend` (`text.trim() !== "" &&
checked.size > 0`), `subscribe`/`snapshot` per `docs/forms.md`. Constructed once per popover
  open (`useState(() => createBroadcastPinnedComposerModel(targets))`, reset via a fresh
  `key`/remount on open, not `useMemo` on `targets`).
- `broadcast-pinned-button.tsx`: `ToolbarButton` (same props/style as the existing grid button in
  `pinned-section-header.tsx`) as `DropdownMenuTrigger`; `DropdownMenuContent` renders the model's
  snapshot: an `AdaptiveTextInput multiline` for the prompt (Enter-to-send wired the same way
  `composer/index.tsx`'s message input does — plain Enter submits, no modifier-key special case
  beyond what the regular composer already does), one `MenuItem` per target
  (`selected={checked.has(target.id)}`, `closeOnSelect={false}`, leading `AgentStatusDot`,
  trailing/label = target's `label` + workspace name), and a trailing "Send to N agents"
  `MenuItem`/button disabled when `!canSend`. On press: call `sendBroadcastPinnedPrompt`, then:
  - all succeeded -> `toast.show(t("broadcastPinned.sent", { count }))`, close the menu.
  - partial failure -> `toast.error(t("broadcastPinned.partialFailure", { names }))`, keep the
    menu open with the current text (do not clear `model.text`).
  - button is rendered by the caller only when `hasTargets` (R1); internal to the component when
    `targets.length === 0` it renders `null` as a defensive fallback.
- `pinned-section-header.tsx`: accept `broadcastPinnedProps: { targets, onSend } | null` (null
  hides the button) as a new prop, render `<BroadcastPinnedButton {...props} />` as a sibling of
  the existing grid `ToolbarButton`, inside the same `row` View.
- `sidebar-workspace-list.tsx`: call `useBroadcastPinnedTargets()` and build the `onSend` closure
  (host-runtime client getter, submission writer, active-turn resolver per U2), pass both into
  `PinnedSectionHeader` next to `onOpenGrid`, mirroring `handleOpenPinnedGrid`'s existing wiring.
- Platform gating: no `isWeb`/`isNative` branches needed — the menu engine already owns the
  popover/sheet split via `useIsCompactFormFactor()` internally; this feature adds no new
  platform-specific code. `AdaptiveTextInput` already resolves to the right native text input on
  each platform.
- i18n: add `broadcastPinned.*` keys (`openButton` tooltip, `promptPlaceholder`, `sendButton`
  with a `{{count}}` plural, `sent`, `partialFailure` with a `{{names}}` interpolation) to
  `en.ts` and every other locale resource file, following the existing `sidebar.pinned.*` /
  `composer.errors.*` key shape.

**Execution note:** This unit has no pre-existing characterization gap (new files), but the
cited `docs/forms.md` lifecycle rules (fresh model per open, no `useMemo` keyed on live data) are
load-bearing — write the model test first to pin its `canSend`/reset behavior before wiring the
component.

**Patterns to follow:** `packages/app/src/workspace-labels/picker.tsx` (checklist +
`hoverIntent: false` input page, nearly 1:1 structural match), `packages/app/src/schedules/*`
(form-model lifecycle rules), `packages/app/src/components/agent-status-dot.tsx` (status
indicator for each row), `packages/app/src/components/sidebar/pinned-section-header.tsx`
(existing `ToolbarButton` + tooltip convention for the trigger).

**Test scenarios:**

- Model: `canSend` is false with empty text regardless of checked targets.
- Model: `canSend` is false with non-empty text but zero checked targets.
- Model: `toggleTarget` flips a single target's checked state without affecting others.
- Model: constructed with N targets starts with all N checked.
- Browser test: renders one row per target, all checked by default; unchecking one lowers the
  selected count used in the Send button's label/disabled state.
- Browser test: Send button disabled with empty text; enabled once text is entered and at least
  one target stays checked.
- Browser test: pressing Send with all-success fan-out shows the "Sent to N agents" toast path and
  closes the composer (assert via the model/`onSend` mock, not real network).
- Browser test: pressing Send with a simulated partial failure keeps the text in the box and
  surfaces the failed agents (assert the error-toast call args name the failed targets).
- Button visibility: a focused test/assertion that `PinnedSectionHeader` renders no broadcast
  button when `broadcastPinnedProps` is `null` / `targets.length === 0`, and renders it when at
  least one target exists (covers R1's "visible only when at least one pinned leader agent
  qualifies").

**Verification:** `npx vitest run` on all new/touched test files in this unit, plus
`broadcast-pinned-targets.test.ts` and `broadcast-pinned-send.test.ts` from U1/U2, all green;
`npm run typecheck` clean; `npm run lint`/`npm run format` clean on touched files; the
`packages/app/src/i18n/resources.test.ts` key-parity check still passes after the locale edits.

---

## Verification Contract

- `npx vitest run packages/app/src/broadcast-pinned/*.test.ts packages/app/src/broadcast-pinned/*.browser.test.tsx packages/app/src/i18n/resources.test.ts packages/app/src/components/sidebar/pinned-section-header.test.tsx packages/app/src/components/sidebar-workspace-list.test.tsx` (adjust the last two paths to whatever existing test files already cover those modules) — no `--bail`, confirm the file list is non-empty before running.
- `npm run typecheck`
- `npm run format:files -- <touched files>`
- `npm run lint -- <touched files>`
- Never run the full suite; never touch `*.e2e.test.ts`; never touch the live daemon on 6767.

## Definition of Done

- All Implementation Units' test scenarios pass.
- Typecheck, lint, and format are clean on every touched/new file.
- The button appears next to the grid button only when at least one pinned leader agent exists,
  opens a popover (wide) / sheet (compact) with a multi-line prompt box and a deselectable,
  checked-by-default target list, and sending reuses the composer's own client RPC with one
  parallel request per selected agent, surfacing success/partial-failure via toast per R5.
- No new RPC, no `packages/app/src/agent-stream/` changes.
