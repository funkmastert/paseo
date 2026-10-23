---
title: "feat: Agent ID visible + prefix lookup for MCP agent tools"
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# feat: Agent ID visible + prefix lookup for MCP agent tools

## Summary

Tyler wants to read an agent's ID off the UI and use it (full or as a short prefix) to address
that agent from another agent. Two of the three requested UI pieces already exist in this
worktree (`AgentIdChip` in the workspace-screen header, and a tab-strip "Copy agent ID" menu
item) — this plan does the one UI piece that is missing (a "Copy ID" item on sidebar session
rows) and the full server piece (a shared agent-identifier resolver reused by the session RPC
path and the Paseo MCP agent tools, so a short id or unique prefix works everywhere a full id
does today, without widening what a caller may touch).

## Problem Frame

Today `packages/server/src/server/session.ts` has a private `resolveAgentIdentifier` method
(exact id, unique prefix, or unique title) used only by three session RPC handlers
(`fetch_agent`, `send_agent_message`, `wait_for_finish`). The Paseo MCP agent tools in
`packages/server/src/server/agent/tools/paseo-tools.ts` look agents up with
`agentManager.getAgent(agentId)` / `agentStorage.get(agentId)` directly, so an agent that was
only given another agent's 7-char short id (visible in the UI) cannot address it.

On the UI side, Tyler asked for the short id to be visible in the agent header (tap to copy) and
on every session row's menu. Research found the header chip and the desktop tab-menu "Copy agent
ID" item already shipped (`5c3051189`, pre-dating this task). The one gap is the sidebar session
row's own ⋯ / long-press / right-click menu, which has no "Copy ID" entry.

## Requirements

- R1. Every session row's menu (desktop right-click, desktop/compact kebab) has a "Copy ID" item
  that copies the row's agent's full id, with the existing copy+toast feedback pattern. Hidden
  when the row has no associated agent. Rows themselves are unchanged (no id text added to the
  row).
- R2. A single shared resolver (exact id, unique prefix, unique title) is used by both the
  session RPC path (`session.ts`) and every agentId-accepting Paseo MCP agent tool. Resolution
  runs before each tool's existing authorization/scoping checks and never widens what those
  checks already allow for a full id.
- R3. An ambiguous prefix returns a clear error listing candidate ids, matching the session path's
  existing error shape. An unknown identifier returns the existing not-found error.
- R4. Every agentId-accepting Paseo MCP tool's parameter description says an id or unique prefix
  (the 7-char short id) works.

(The header short-id chip and the desktop tab-menu "Copy agent ID" item, R1's UI sibling for the
tab strip, already exist and need no change — see Key Technical Decisions.)

## Key Technical Decisions

- **KTD1 — Reuse, don't rebuild, the header/tab-menu pieces.** `AgentIdChip`
  (`packages/app/src/components/agent-id-chip.tsx`) already renders the short id in the
  workspace-screen header (`packages/app/src/screens/workspace/workspace-screen.tsx:498-501`)
  with tap-to-copy + toast + web hover tooltip, and the desktop tab strip's kebab already has a
  "Copy agent ID" item (`workspace-tab-menu.ts`, `workspace-desktop-tabs-row.tsx`). Both predate
  this task (commit `5c3051189`, 2026-09-24). This plan does not touch either; it only adds the
  missing sidebar-row equivalent.
- **KTD2 — Source the row's agent id from the existing per-workspace activity index**, not a new
  field threaded from the daemon. `WorkspaceAgentActivity.agentId`
  (`packages/app/src/utils/workspace-agent-activity.ts`) already carries the primary agent id per
  workspace, keyed in `workspaceAgentActivity: Map<string, WorkspaceAgentActivity>`
  (`sidebar-workspaces-view-model.ts`). `SidebarWorkspaceEntry` itself has no agent id field today
  — chosen over adding a parallel lookup because `createSidebarWorkspaceEntry` already receives
  `workspaceAgentActivity` and derives `completionState`/`completionNote` from the same map; one
  more derived field is the smallest change, not a new prop-drilling path.
- **KTD3 — Extract `resolveAgentIdentifier` as a standalone function**, not a shared base class or
  mixin. It depends only on `agentStorage.list()` and `agentManager.listAgents()`, both already
  plain dependencies on every call site (session and the MCP tool catalog), so a function taking
  `{ agentStorage, agentManager }` is the direct extraction — no interface abstraction needed
  (one real caller shape, not two).
- **KTD4 — Resolve inside the MCP tool catalog closure, before calling the underlying command**,
  not inside each `*Command` function. The commands (`cancelAgentRunCommand`, `archiveAgentCommand`,
  `setCompletionStateCommand`, etc.) are also called from non-MCP paths in some cases and already
  take a plain `agentId: string`; resolving at the tool boundary keeps those commands' contracts
  and their existing authorization checks (e.g. `set_completion_state`'s parent-id check in
  `completion-state-command.ts`) unchanged. Authorization on the _resolved_ full id is what
  satisfies "resolution never widens access."

## Implementation Units

### U1. Extract the shared agent-identifier resolver

**Goal:** Pull `resolveAgentIdentifier` out of `Session` into a standalone, reusable function.

**Requirements:** R2, R3

**Dependencies:** none

**Files:**

- `packages/server/src/server/agent/resolve-agent-identifier.ts` (new)
- `packages/server/src/server/agent/resolve-agent-identifier.test.ts` (new)
- `packages/server/src/server/session.ts` (modify)

**Approach:** Move the body of `Session.resolveAgentIdentifier`
(`packages/server/src/server/session.ts:5378-5429`) verbatim into a new exported function:

```ts
export type ResolveAgentIdentifierResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export async function resolveAgentIdentifier(
  identifier: string,
  deps: { agentStorage: Pick<AgentStorage, "list">; agentManager: Pick<AgentManager, "listAgents"> },
): Promise<ResolveAgentIdentifierResult> { ... }
```

Delete the private method from `Session` and update its three call sites
(`handleFetchAgent` at ~7895, `handleSendAgentMessageRequest` at ~8377, `handleWaitForFinish` at
~8479) to call the imported function with `{ agentStorage: this.agentStorage, agentManager: this.agentManager }`. No behavior change on the session path — this unit is a pure extraction.

**Patterns to follow:** sibling standalone command modules in the same directory
(`agent-loading.ts`, `lifecycle-command.ts`, `completion-state-command.ts`) — a plain exported
function taking a small deps object, no class.

**Test scenarios:**

- Exact id match → `{ ok: true, agentId: <that id> }`.
- Unique prefix of a live agent's id → resolves to that agent's full id.
- Unique prefix of a stored (not live) agent's id → resolves to that agent's full id.
- Prefix matching 2+ known ids → `{ ok: false }` with an error naming the ambiguous candidates
  (truncated list, matching the existing `.slice(0, 5)` / `", …"` shape).
- Unique title match (no id/prefix match) → resolves to that record's id.
- Title matching 2+ records → `{ ok: false }` ambiguous-title error.
- Empty/whitespace-only identifier → `{ ok: false, error: "Agent identifier cannot be empty" }`.
- Completely unknown identifier → `{ ok: false, error: "Agent not found: <identifier>" }`.
- Internal agent records (`record.internal === true`) are excluded from id/title candidate pools
  (mirrors the current filter).

**Verification:** `resolve-agent-identifier.test.ts` passes; `session.ts` still typechecks and its
three call sites behave identically (no session test regressions).

---

### U2. Resolve every agentId-accepting Paseo MCP tool through the shared resolver

**Goal:** A short id or unique prefix works everywhere a full agent id works today in the MCP
tool catalog, with the same authorization/scoping as a full id.

**Requirements:** R2, R3, R4

**Dependencies:** U1

**Files:**

- `packages/server/src/server/agent/tools/paseo-tools.ts` (modify)
- `packages/server/src/server/agent/tools/paseo-tools.test.ts` (modify/extend)

**Approach:** Inside `createPaseoToolCatalog`, add one local helper that closes over
`agentManager`/`agentStorage` (already in scope):

```ts
async function resolveToolAgentId(identifier: string): Promise<string> {
  const resolved = await resolveAgentIdentifier(identifier, { agentStorage, agentManager });
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.agentId;
}
```

Apply it at the top of each handler, before any authorization-sensitive read, for these tools
(resolve the `agentId` input param, use the resolved value for everything downstream):

- `get_agent_status` (~2218) — resolve before `agentManager.getAgent` / `agentStorage.get`.
- `get_agent_activity` (~3404) — resolve before `ensureAgentLoaded` / `getTimeline` / `getAgent`.
- `cancel_agent` (~2350) — resolve before `cancelAgentRunCommand`.
- `archive_agent` (~2375) — resolve before `archiveAgentCommand`.
- `kill_agent` (~2403) — resolve before `closeAgentCommand`.
- `update_agent` (~2429) — resolve before the `setAgentMode`/`setAgentModel`/
  `setAgentThinkingOption`/`setAgentFeature` calls and `updateAgentCommand`.
- `set_agent_mode` (~3457) — resolve before `setAgentModeCommand`.
- `respond_to_permission` (~3515) — resolve before `respondToAgentPermission`.
- `set_completion_state` (~2481) — the `agentId` param is _optional_ (omitted means "target
  myself"). Resolve only when provided: `const resolvedAgentId = agentId !== undefined ? await
resolveToolAgentId(agentId) : undefined;` then pass `resolvedAgentId` into
  `setCompletionStateCommand`'s input. `completion-state-command.ts`'s own `resolveTarget` parent-id
  check then runs unchanged on the resolved full id — this is the case that proves resolution
  does not widen access (a prefix that resolves to an agent that is _not_ the caller's child is
  still refused).
- `send_agent_prompt` (~2107) — resolve `requestedAgentId` to `resolvedAgentId` and pass
  `resolvedAgentId` into `sendPromptToAgent`. **Careful:** the existing `moved` detection compares
  `sendPromptToAgent`'s returned `agentId` (post account-failover) against the _original_ request
  id to decide whether to report `deliveredToAgentId`. That comparison must change to compare
  against `resolvedAgentId` (not `requestedAgentId`), or every short-id call would spuriously
  report "moved" since a prefix never equals the full id it resolves to.

For every one of these tools' `inputSchema.agentId` (and `set_completion_state`'s optional
`agentId`), update the Zod `.describe(...)` text to say the id can be a unique prefix, e.g.
`"Agent ID or unique prefix (the 7-char short ID works)."` — add `.describe(...)` where the field
currently has none (several are bare `z.string()`).

**Patterns to follow:** the existing `create_agent` spend-governor check at the top of its
handler (`paseo-tools.ts:1634-1644`) — a guard that runs first and throws a plain `Error` before
anything else executes.

**Test scenarios:**

- `get_agent_status` with a unique 7-char prefix of a live agent's id → returns that agent's
  snapshot (same shape as calling with the full id).
- `get_agent_status` with a prefix matching two known agents → throws with the resolver's
  ambiguous-identifier message (candidates listed).
- `get_agent_status` with an unknown prefix → throws the resolver's not-found message.
- `cancel_agent` (or `kill_agent`) with a unique prefix → cancels/kills the correct agent.
- `send_agent_prompt` with a unique prefix, where the agent has _not_ moved accounts → response
  has no spurious `deliveredToAgentId`/`guidance` (regression check for the comparison fix).
- **Scoped-tool proof:** `set_completion_state` called by `parent-1` with a prefix that uniquely
  resolves to `stranger-1` (an agent that is _not_ `parent-1`'s child) → still throws
  `Refused: parent-1 is not the parent of stranger-1` (or equivalent), proving prefix resolution
  does not reach an agent the caller could not already reach by full id. Mirror the existing "a
  parent may set state on its own child via agentId" test in `paseo-tools.test.ts`, but address
  the non-child by a unique prefix instead of its full id.
- `set_completion_state` with no `agentId` (targets self) is unaffected by the resolver (no
  regression on the existing "resolves to the caller itself" test).

**Verification:** `paseo-tools.test.ts` passes, including the new prefix and ambiguous/scoped
cases; `npm run typecheck` on `@getpaseo/server` is clean.

---

### U3. Thread the primary agent id onto `SidebarWorkspaceEntry`

**Goal:** Give every sidebar row component access to its workspace's current agent id, so the
row menu (U4) can offer "Copy ID".

**Requirements:** R1

**Dependencies:** none

**Files:**

- `packages/app/src/hooks/sidebar-workspaces-view-model.ts` (modify)
- `packages/app/src/hooks/sidebar-workspaces-view-model.test.ts` (modify/extend)

**Approach:** Add `agentId: string | null` to the `SidebarWorkspaceEntry` interface (alongside
`completionState`/`completionNote`). In `createSidebarWorkspaceEntry`, set it independently of
`deriveEffectiveWorkspaceStatus`'s status-gated lookup (that one only reads activity when the
workspace is `"done"`; the id itself has no such gate):

```ts
agentId: input.workspaceAgentActivity?.get(input.workspace.id)?.agentId ?? null,
```

**Test expectation:** none for the interface change itself — this is scaffolding verified by U4's
tests, which cover the end-to-end behavior through `createSidebarWorkspaceEntry`. If
`sidebar-workspaces-view-model.test.ts` already has a general "builds the right entry fields"
case, extend it with an `agentId` assertion (present when activity has one, `null` otherwise) —
no new test file needed for this unit alone.

**Verification:** `npm run typecheck` on `packages/app`; existing `sidebar-workspaces-view-model`
tests still pass with the new field included.

---

### U4. "Copy ID" on every sidebar session row menu

**Goal:** Every session row's ⋯ / long-press / right-click menu gets a "Copy ID" item, copying
the row's agent's full id, hidden when the row has no agent.

**Requirements:** R1

**Dependencies:** U3

**Files:**

- `packages/app/src/hooks/use-workspace-clipboard-actions.ts` (modify)
- `packages/app/src/components/sidebar/sidebar-workspace-menu.tsx` (modify)
- `packages/app/src/components/sidebar/sidebar-workspace-row.tsx` (modify)
- `packages/app/src/components/sidebar-workspace-list.tsx` (modify)
- `packages/app/src/components/sidebar/sidebar-status-list.tsx` (modify)
- `packages/app/src/i18n/resources/{en,ar,es,fr,ja,ko,pt-BR,ru,zh-CN}.ts` (modify)
- `packages/app/src/components/sidebar/sidebar-workspace-menu.browser.test.tsx` (new)

**Approach:**

1. **Clipboard action.** Add `copyAgentId: (agentId: string) => void` to `WorkspaceClipboardActions`
   / `useWorkspaceClipboardActions()` (`use-workspace-clipboard-actions.ts`), mirroring
   `copyBranchName`: `Clipboard.setStringAsync(agentId)` then
   `toast.copied(t("sidebar.workspace.toasts.agentIdCopied"))`. Takes a plain `agentId: string`
   (not a `CopyableWorkspace`) since it has no derived-from-workspace logic.
2. **Menu item.** In `sidebar-workspace-menu.tsx`, add `onCopyAgentId?: () => void` to
   `SidebarWorkspaceMenuProps` and `SidebarWorkspaceMenuItemsProps`, and render one more
   `WorkspaceMenuItem` in `SidebarWorkspaceMenuItems` (reuse `copyLeadingIcon`), labeled
   `t("sidebar.workspace.actions.copyAgentId")`, grouped with the existing `onCopyPath`/
   `onCopyBranchName` items (same conditional-render-when-present pattern). Thread the prop
   through both `SidebarWorkspaceMenu` and `SidebarWorkspaceContextMenu` to
   `SidebarWorkspaceMenuItems`, same as the two existing copy props.
3. **Wire the three row-list call sites** that each already duplicate the `onCopyPath`/
   `onCopyBranchName` wiring (this duplication is pre-existing, not introduced here — match it,
   don't refactor it away):
   - `sidebar-workspace-row.tsx` — add `handleCopyAgentId` (via `clipboard.copyAgentId`) beside
     `handleCopyPath`/`handleCopyBranchName` (~108-115); pass
     `onCopyAgentId={workspace.agentId ? handleCopyAgentId : undefined}` through
     `WorkspaceRowBodyProps`/`WorkspaceRowBody` to both `SidebarWorkspaceContextMenu` (~294-323)
     and the `WorkspaceRowTrailingActions` → `SidebarWorkspaceMenu` path (~335-349, ~436-452).
   - `sidebar-workspace-list.tsx` — same shape at its two `SidebarWorkspaceMenu`/
     `SidebarWorkspaceContextMenu` call sites (~628-696, ~1080-1218) and its own
     `handleCopyPath`/`handleCopyBranchName` block (~1303-1389).
   - `sidebar-status-list.tsx` — same shape (~666-728, ~767-1045).
4. **i18n.** Add `sidebar.workspace.actions.copyAgentId` (English: `"Copy ID"`) and
   `sidebar.workspace.toasts.agentIdCopied` (English: `"ID copied"`) to the `sidebar.workspace.actions`
   / `sidebar.workspace.toasts` blocks in every shipped locale file (see the existing
   `copyBranchName`/`branchNameCopied` entries in each file for the exact namespace path), with a
   real translation per locale matching that file's existing style for sibling copy-action
   strings (not a copied-English placeholder).

**Patterns to follow:** `copyBranchName`/`branchNameCopied` end-to-end — same hook shape, same
menu-item conditional-render shape, same three-call-site wiring shape.

**Test scenarios:**

- `SidebarWorkspaceMenuItems` renders a "Copy ID" item when `onCopyAgentId` is provided, and omits
  it when `onCopyAgentId` is `undefined` (covers the "no agent for this row" case).
- Clicking/selecting "Copy ID" calls the provided `onCopyAgentId` handler (desktop dropdown
  surface) and the context-menu surface (`surface="context"`).
- `useWorkspaceClipboardActions().copyAgentId(id)` writes `id` to the clipboard and fires
  `toast.copied` with the `agentIdCopied` label (mirror the existing `copyBranchName` test, if one
  exists, or the `agent-id-chip.browser.test.tsx` click→toast-text assertion pattern).
- A row whose `workspace.agentId` is `null` (no agent in that workspace yet) does not pass an
  `onCopyAgentId` callback into either menu wrapper, so no "Copy ID" item appears for that row.

**Verification:** new `sidebar-workspace-menu.browser.test.tsx` passes (`vitest --project browser`
on `packages/app`); `npm run typecheck` on `packages/app`. Manual spot check: open the dev app,
right-click a sidebar workspace row with a running agent, confirm "Copy ID" appears and copies
the full id (toast fires); confirm it's absent on a workspace row with no agent yet.

## Verification Contract

- `npm run typecheck` (repo root) — clean.
- `npm run lint -- <every file touched by U1-U4>` — clean.
- `npm run format:files -- <every file touched by U1-U4>` — clean (if it reports no files found
  under the default ignore path, retry with `--ignore-path=$HOME/.cache/self-heal-briefs/empty-ignore`
  and say so in the final report).
- One `vitest run` (no `--bail`) covering:
  - `packages/server/src/server/agent/resolve-agent-identifier.test.ts`
  - `packages/server/src/server/session.test.ts` (regression on the three call sites U1 touched)
  - `packages/server/src/server/agent/tools/paseo-tools.test.ts`
  - `packages/app/src/hooks/sidebar-workspaces-view-model.test.ts`
  - `packages/app/src/components/sidebar/sidebar-workspace-menu.browser.test.tsx` (`--project browser`)

  Pipe output to a file and read it back rather than relying on exit code alone.

- Before `npm run typecheck` on server changes, run `npm run build:server-deps` then
  `npm run build --workspace=@getpaseo/server` (cross-workspace declaration staleness).

## Definition of Done

- U1-U4 implemented and committed.
- Verification Contract gates all pass, with output captured.
- A screenshot of the sidebar row "Copy ID" menu item (via the repo's browser capture harness)
  saved under `/tmp`, if the harness is reachable in this environment.
- No push, no PR — this plan's execution stops at local commit(s) per the invoking instructions.

## Scope Boundaries

**Out of scope:**

- The header short-id chip and the desktop tab-strip "Copy agent ID" item — already shipped
  (KTD1).
- Any new WebSocket RPC or protocol field — U2's resolver is server-internal; no wire shape
  changes.
- Printing the id directly on a sidebar row's visible text (explicitly excluded by the request).

### Deferred to Follow-Up Work

- None identified — this is a small, self-contained pair of changes.

## Assumptions

- "Every session row's menu" means every sidebar workspace row surface that already carries a ⋯/
  right-click menu today (`sidebar-workspace-row.tsx`, `sidebar-workspace-list.tsx`,
  `sidebar-status-list.tsx`), not a new menu surface. No other row-with-menu surface (pinned grid
  cell, orchestration row, command center) was named by the request and none currently lacks the
  chip already (KTD1), so none are touched here.
- Non-English translations for the two new strings are written directly (plausible, idiomatic
  translations matching each file's existing sibling strings), not sourced from a translation
  service — consistent with how this repo's other recent single-string i18n additions were done.
