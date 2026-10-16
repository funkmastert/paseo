---
title: Fully Hide Agent-Created Workspaces (Not Just Collapse Them) - Plan
type: feat
date: 2026-10-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Fully Hide Agent-Created Workspaces (Not Just Collapse Them) - Plan

## Goal Capsule

- **Objective:** Tyler's sidebar, and every other workspace-browsing list, shows only workspaces
  he made. A workspace an agent made never appears unless he pinned it himself.
- **Authority:** this plan, then `docs/done-janitor.md` ("Idle workspaces",
  "Manual pin vs. auto-pin"), `docs/agent-lifecycle.md`, `docs/protocol-compatibility.md`,
  `CLAUDE.md`. Grounding: `~/bozeo-ops/briefs/hide-agent-workspaces.md` (local).
- **Execution profile:** one worker, U1-U3 in order.
- **Stop conditions:** stop and report if a change would let the done janitor archive a workspace
  it does not archive today, or would hide a workspace that is Tyler's.
- **Tail ownership:** the worker commits locally and never pushes or restarts the 6767 daemon.

---

## Product Contract

### Problem Frame

Tyler, 2026-10-14 (verbatim): "In the left sidebar I see a bunch of workspaces that agents
created. I don't want to see them, clean them up when done and don't even show any workspace
that is not a real original workspace that I created."

An earlier pass (PR #22, `fix/sidebar-agent-workspaces`, already merged into this branch's base)
built the two hard parts of this already:

1. **Provenance.** Every workspace record carries `createdBy: "person" | "agent"`
   (`packages/server/src/server/workspace-registry.ts`), set at creation by
   `resolveWorkspaceCreatedBy`/`isHumanAttributableCreate` (`workspace-auto-pin.ts`) from
   `callerAgentId` and the inherited `paseo.parent-agent-id` label, and backfilled once at boot
   for older records (`workspace-created-by-migration.ts`). Verified end-to-end for every
   creation path the brief names: `workspace.create.request` (both directory and worktree
   flavors, `session.ts:6854` and `session.ts:6941`), `create_agent_request`
   (`session.ts:4239`), the agent-scoped MCP `create_workspace`/`create_agent` tools (same
   `callerAgentId` plumbing, `agent/tools/paseo-tools.ts`), the `paseo` CLI under
   `PASEO_AGENT_ID` (and by the same mechanism, any bozeo CLI spawn that sets it), schedules,
   heartbeats, remediation, and restart recovery (`docs/done-janitor.md` line 228). No new
   creation path exists to cover; **no server-side change is planned.**
2. **Cleanup.** The done janitor's `agent-done` sweep rule
   (`packages/server/src/server/agent/workspace-sweep-detector.ts`) already archives a
   `createdBy: "agent"` workspace one hour after its last agent archives, ahead of `idle`/`empty`.
   Directory deletion still goes through the ordinary git gate and snapshot for a Paseo-owned
   worktree, record-only for anything else — unchanged, per R6 of the earlier plan. The sweep's
   `dryRun` defaults to `true` and logs one `would-archive-workspace`/`would-delete` line per
   workspace (`docs/done-janitor.md`, "Approving the first live run"), so the brief's "dry-run
   flag" and "log one line per workspace" requirements are already met. **No change is planned
   here either** — Tyler's deploy is what flips `dryRun` to `false` and runs the backlog; this
   plan does not touch that config or archive any live workspace.

What that pass did **not** finish, and what Tyler's new ask actually requires: it put every
`agent` workspace into one collapsed "Agent workspaces (N)" section at the bottom of the sidebar
— visible, just closed by default. That is not what "don't even show" means. The remaining gap is
**full hiding**, applied consistently everywhere a list of workspaces can appear.

### Requirements

- R1. The sidebar never renders an agent-made workspace, in either grouping mode (project or
  status), on any client. No collapsed section, no header, no count. A workspace Tyler pinned
  himself still shows in Pinned, exactly as it does for a person-made workspace — a pin is an
  explicit signal, and the backlog of already-collapsed agent workspaces loses nothing by this:
  nobody was looking at a default-collapsed section anyway.
- R2. The command palette's "jump to workspace" list (`command-center.tsx`) applies the same
  hidden rule. An agent's own row (search by title/cwd) is unaffected — only the workspace-level
  entries are filtered, so a child agent stays reachable by name even though its workspace row is
  gone.
- R3. One predicate decides "hidden" everywhere: `createdBy === "agent"` and no `pinnedAt`. It
  takes exactly the fields already on `WorkspaceDescriptor`/`SidebarWorkspaceEntry`, so no new
  store or lookup is needed to use it.
- R4. Every other place that lists workspaces is audited and the decision is recorded (see
  "Other lists" below) rather than guessed at.
- R5. Dead code the collapsed section leaves behind (the group variant, its icon, its tests) is
  removed rather than left to rot, per `ce-simplify-code`.

### Other lists — audited, left alone, and why

- **Pinned grid** (`pinned-grid-screen.tsx`) and **broadcast-to-pinned-leaders picker**
  (`use-broadcast-pinned-targets.ts`): both resolve only from `pinnedGroups.pinnedChats`, which is
  pin-based, not an exhaustive workspace scan. An agent workspace only ever appears here because
  Tyler pinned it — the same exception R1 grants the sidebar. Nothing to change.
- **Auto-pin** (`workspace-auto-pin.ts`): decides whether to pin a workspace at creation time, not
  what a list shows later. Out of scope by the brief's own scope boundary.
- **Orchestration panel** (`orchestration-panel.tsx`, `orchestration-visibility.ts`): rows are
  agents, not workspaces, and the panel's stated job is "what is happening now" across the whole
  fleet — `isPinnedOrchestrationAgent` already keeps anything live, blocked, failed, or over
  budget regardless of age. Hiding agent-made workspaces here would hide the exact work the panel
  exists to surface. Left alone.
- **Workspace switcher / command palette**: in scope, R2 above — this is the one other list that
  actually enumerates every workspace the way the sidebar does.

### Scope Boundaries

- No change to `createdBy`, its backfill, or any creation path (Outcome 1 — already correct).
- No change to the done janitor's sweep rules, config keys, or defaults (Outcome 3 — already
  correct). No live workspace is archived by this work.
- No change to pinning, auto-pin, or the orchestration panel.
- No change to which directories the done janitor may delete.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. The hidden predicate lives in one new file, `packages/app/src/utils/workspace-visibility.ts`,
  typed against `Pick<WorkspaceDescriptor, "createdBy" | "pinnedAt">` so it works unchanged
  against both `SidebarWorkspaceEntry` (sidebar) and the raw `WorkspaceDescriptor` the command
  palette reads from `useProjects()`. `sidebar-projection.ts` and `command-center.tsx` both import
  it; nothing else reimplements the check.
- KTD-2. In `sidebar-projection.ts`, the agent/person split that already exists (built for the
  collapsed section) is kept — it is exactly the filter R1 needs — but the code now expresses it
  by calling the shared predicate instead of inlining `workspace.createdBy === "agent"`, and the
  result is never turned into a group or pushed into `sections`/`workspaceGroups`. It is simply
  dropped.
- KTD-3. Removing the agent group collapses `SidebarWorkspaceGroup.leading` back to its one
  remaining shape (`{ kind: "status"; bucket: StatusBucket }`), which lets
  `isSidebarWorkspaceGroupCollapsed` drop its agent-flavored branch and `sidebar-status-list.tsx`
  drop `AgentGroupIcon` and its attention-dot styles entirely — dead code the earlier pass left
  behind once there is no second `leading.kind` to render.
- KTD-4. `agentWorkspacesGroup`, `AGENT_WORKSPACES_GROUP_KEY`, and
  `AGENT_GROUP_ATTENTION_BUCKETS` in `sidebar-labels.ts` are deleted outright rather than kept
  unused — nothing else references them once U1 lands.
- KTD-5. The pin exception (R1's last sentence) needs no new logic in `sidebar-projection.ts`:
  pinned workspaces are already split out of `unpinnedWorkspaces` before the agent/person split
  runs, so they never reach the predicate at all. In `command-center.tsx`, where there is no
  prior pin split, the predicate's own `pinnedAt` check does the same job directly against
  `WorkspaceDescriptor.pinnedAt`.

---

## Implementation Units

### U1. Shared predicate, and the sidebar fully hides instead of collapsing

**Requirements:** R1, R3, R5; KTD-1, KTD-2, KTD-3, KTD-4, KTD-5.

**Files:**

- `packages/app/src/utils/workspace-visibility.ts` (new) and its test
- `packages/app/src/components/sidebar/sidebar-labels.ts` and `sidebar-labels.test.ts`
- `packages/app/src/components/sidebar/sidebar-projection.ts` and `sidebar-projection.test.ts`
- `packages/app/src/components/sidebar/sidebar-status-list.tsx` (remove `AgentGroupIcon`, the
  `leading.kind === "agent"` branch, and the now-unused attention-dot styles)
- `packages/app/src/components/sidebar-workspace-list.tsx` (the stale comment at the
  `StatusGroupList` render site describing the collapsed agent section)
- `packages/app/src/hooks/use-sidebar-shortcut-model.test.tsx` (drop any assertion keyed on the
  agent group's shortcut section)
- delete `packages/app/src/components/sidebar/sidebar-agent-workspaces-section.browser.test.tsx`
  — it exercises the collapsed header and its attention dot, neither of which exists after this
  unit; its coverage is replaced by the plain unit tests in `sidebar-projection.test.ts`

**Approach:** `workspace-visibility.ts` exports one function,
`isHiddenAgentWorkspace(workspace: { createdBy?: "person" | "agent"; pinnedAt?: string | null }): boolean`,
returning `workspace.createdBy === "agent" && !workspace.pinnedAt`. `buildSidebarProjection` keeps
splitting `unpinnedWorkspaces` into person/agent (reusing the predicate for the split), but the
agent branch is now discarded — no `agentWorkspacesGroup` call, no `workspaceGroups.push`, no
`sections.push` for it, in either grouping mode. `withoutAgentWorkspaces` (filtering a project's
unpinned list before building `pinnedGroups.unpinnedProjects`) is unchanged, since it already
drops exactly these rows from the project view.

**Test scenarios:**

- `isHiddenAgentWorkspace`: `createdBy: "agent"`, no `pinnedAt` -> hidden. `createdBy: "agent"`
  with a `pinnedAt` -> not hidden. `createdBy: "person"` -> not hidden regardless of `pinnedAt`.
  `createdBy` missing (COMPAT: older daemon) -> not hidden, same as `"person"`.
- `buildSidebarProjection`, project mode: an unpinned agent workspace is absent from both
  `pinnedGroups.unpinnedProjects` and `workspaceGroups` (today it lands in `workspaceGroups` as
  the agent section; after this unit `workspaceGroups` is empty for project mode whenever there
  are no status groups).
- `buildSidebarProjection`, status mode: an unpinned agent workspace is absent from every
  `SidebarWorkspaceGroup.rows` across all buckets.
- A manually pinned agent workspace still appears in `pinnedGroups.pinnedChats` and nowhere else,
  in both modes (regression: the pin exception must survive the removal of the collapsed
  section).
- A mix of pinned/unpinned, person/agent workspaces in one project produces exactly the person +
  pinned rows, nothing more.

**Verification:** `npx vitest run packages/app/src/utils/workspace-visibility.test.ts
packages/app/src/components/sidebar/sidebar-projection.test.ts
packages/app/src/components/sidebar/sidebar-labels.test.ts
packages/app/src/hooks/use-sidebar-shortcut-model.test.tsx --bail=1` from `packages/app`, wrapped
in `~/bozeo-ops/cpu-policing/heavy.sh`.

### U2. Command palette hides the same workspaces

**Requirements:** R2, R3; KTD-1, KTD-5.

**Files:**

- `packages/app/src/command-center/command-center.tsx` (the `allWorkspaces` loop in
  `useBuiltInRows`) and its test, if one exists for this function; otherwise a new
  `command-center.workspace-visibility.test.ts` colocated with the component's existing test
  conventions

**Approach:** filter each `host.workspaces` entry through `isHiddenAgentWorkspace` before pushing
it into `allWorkspaces`, inside the existing `for (const workspace of host.workspaces)` loop,
right after the `workspace.archivingAt` skip it already has. `agentRows` (the agent search
results) are untouched — an agent whose workspace was just filtered still gets a row, falling
back to `shortenPath(agent.cwd)` for its subtitle exactly as it already does when
`workspaceTitleByKey` has no entry for its workspace.

**Test scenarios:**

- An agent-made, unpinned workspace does not appear in `allWorkspaces`.
- A pinned agent-made workspace does appear.
- An agent whose workspace was filtered still appears in `agentRows`, with its subtitle falling
  back to the shortened `cwd` instead of a workspace title.
- A person-made workspace is unaffected (regression).

**Verification:** targeted vitest for the touched test file(s), same `heavy.sh` wrapping.

### U3. Docs: integrate the fully-hidden behavior where the collapsed section used to be described

**Requirements:** R4 (the "other lists" audit becomes part of the record), R5.

**Files:**

- `docs/done-janitor.md` — the sentence "The app's sidebar collapses every `agent` workspace into
  one 'Agent workspaces (N)' section, default-collapsed; the done janitor reads it for the
  `agent-done` rule below" (around line 228) is rewritten to say the sidebar hides them outright,
  and that a pin is the only way one becomes visible again. No other part of that paragraph
  changes — the `createdBy` mechanics it describes are unaffected.
- Any other doc row the earlier plan's own doc-integration touched for the collapsed section
  (checked via `rg "Agent workspaces"` across `docs/` before editing, so nothing is missed or
  duplicated).

**Approach:** integrate in place, per this repo's doc-writing rule — rewrite the sentence that is
now wrong rather than appending a new paragraph about the change.

**Test expectation:** none — documentation only.

---

## Verification Contract

- `~/bozeo-ops/cpu-policing/heavy.sh npm run build:server` once, first, since server dist
  declarations may be stale (no server code changes in this plan, but `packages/app` imports
  `@getpaseo/protocol` types that come from that build chain).
- Targeted vitest only, each run wrapped in `~/bozeo-ops/cpu-policing/heavy.sh`: the files listed
  per unit, run from `packages/app`. Never the full suite, never e2e, never a device run (rapid
  mode, per the brief).
- `npm run lint -- <touched files>` and `npm run format:files -- <touched files>`, then
  `npm run typecheck`.
- No server-side verification needed — Outcomes 1 and 3 are pre-existing and unchanged by this
  plan; this plan only re-confirms them by reading, not by re-running their tests.

## Definition of Done

- R1-R5 met: the sidebar never shows an unpinned agent workspace in either grouping mode, the
  command palette's workspace list matches, the predicate is the one place either list makes the
  call, the dead collapsed-section code is gone, and the other lists are each accounted for with
  a stated reason.
- Targeted tests pass; typecheck and lint are clean on touched files.
- `docs/done-janitor.md` describes the new behavior in place of the old collapsed-section
  sentence.
- Commits are local, on `feat/hide-agent-workspaces`, not pushed.
