---
title: Sidebar Shows Tyler's Workspaces; Agent Workspaces Get Cleaned Up - Plan
type: fix
date: 2026-10-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Sidebar Shows Tyler's Workspaces; Agent Workspaces Get Cleaned Up - Plan

## Goal Capsule

- **Objective:** the sidebar shows the workspaces Tyler made: his real checkouts and the sessions he started. Workspaces agents made are tucked into one collapsed section, and they go away on their own once their agents are done.
- **Authority:** this plan, then `docs/done-janitor.md` ("Idle workspaces", "Manual pin vs. auto-pin"), `docs/agent-lifecycle.md`, `docs/protocol-compatibility.md`, `docs/design.md`, `CLAUDE.md`. Grounding: `~/bozeo-ops/briefs/sidebar-workspaces-grounding.md` (local).
- **Execution profile:** one worker, U1–U4 in order.
- **Stop conditions:** stop and report if a change would let the janitor delete a directory it does not delete today, or would hide a workspace with an agent waiting on Tyler.
- **Tail ownership:** the worker commits locally and never pushes or restarts the 6767 daemon.

---

## Product Contract

### Problem Frame

Tyler, 2026-10-09: "I don't want to see workspace that are not created by me — the actual place the repo code lives. There's not enough cleanup and too many sub agent adding work space."

Live numbers on 2026-10-09:

- 114 unarchived workspaces; 98 of them (86%) hold only archived agents.
- 51 are self-heal fixer workspaces in the home directory, 41 are Paseo worktrees, and 19 are other agent worktrees. Only a couple are Tyler's own checkouts.

Two causes:

1. **No record of who made a workspace.** `callerAgentId` decides auto-pin at creation and is then thrown away (`workspace-auto-pin.ts`), so the sidebar cannot tell an agent's workspace from Tyler's.
2. **The idle-workspace sweep starves.** It is live, but every sweep spends its 10 attempts on workspaces it then keeps:
   - "a process runs inside it: tea (pid …)" — the daemon's own forge polls (`tea pr list`, children of the daemon) running for a few seconds in the workspace's directory;
   - a worktree holding an ignored file that is neither regenerable nor backed up.

   The same candidates come back every sweep, and the backlog never shrinks.

   The leader already raised `workspaceSweep.maxArchivesPerSweep` to 40 in live config as relief (backup `config.json.bak-20261009-wssweep`).

### Requirements

- R1. Every workspace record says who made it: `createdBy: "person" | "agent"`, set at creation by the same rule auto-pin uses. A client request with no `callerAgentId` and no inherited parent label is `person`. Everything else is `agent`: the MCP tools, `paseo` CLI calls with `PASEO_AGENT_ID`, schedules, heartbeats, Hub runs, remediation fixers and restart recovery.
- R2. Existing records get a one-time inferred value. A workspace is `agent` if any agent it ever held carries `paseo.parent-agent-id` or `paseo.remediation`, or if it is a Paseo-owned worktree; otherwise `person`. Inference never overrides a stored value.
- R3. The sidebar lists `person` workspaces as today. `agent` workspaces sit in one "Agent workspaces (N)" section at the bottom, collapsed by default, with the collapsed state remembered. A manually pinned agent workspace shows in Pinned as today. The section header shows an attention dot when any agent inside needs Tyler: a permission, or an error. This works on iOS, Android, web and the Electron desktop, at compact and desktop widths.
- R4. The sweep never counts the daemon's own child processes as "a process runs inside it". Forge polls and the daemon's own `git`/`gh`/`tea` probes spawned by the daemon pid are ignored. Any other process still keeps the workspace.
- R5. A workspace kept for a reason that will not change within the hour (an unbacked ignored path, a process that is not the daemon's) is not re-attempted for `keptCooldownHours` (default 6) and spends no budget meanwhile. The rest of the backlog gets the budget.
- R6. A new sweep rule, `agent-done`: a `createdBy: agent` workspace whose agents are all archived, with no terminal or script running, is archived 1 hour after the last of them was archived. That replaces the 24h `empty` and 72h `idle` thresholds for it. Directories follow the existing deletion rules unchanged: record-only for external worktrees and directories, the git gate and snapshot for Paseo-owned worktrees.

### Scope Boundaries

- No change to which directories may be deleted, or to the deletion invariant, snapshots or git gate.
- No change to auto-pin.
- No new workspace kinds.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. `createdBy` is optional on the persisted record and on the wire descriptor (`WorkspaceDescriptorPayloadSchema`), tagged `COMPAT(workspaceCreatedBy)`. The app treats a missing value as `person`, so nothing disappears when an older daemon serves it. The feature is gated on `server_info.features.workspaceCreatedBy`.
- KTD-2. The creation-time rule lives next to `workspace-auto-pin.ts`'s caller check and reuses it, so "person" means exactly what auto-pin already means.
- KTD-3. The backfill runs once at registry load for records with no `createdBy`, from the agent records' labels, and is persisted atomically like other registry writes. It is idempotent.
- KTD-4. Sidebar: `buildSidebarProjection` / `buildWorkspaceGroups` (`packages/app/src/components/sidebar/sidebar-projection.ts`) partition rows by `createdBy` before grouping, in both `project` and `status` group modes. The agent section reuses the existing collapsible group component and its persisted-collapse pattern; no parallel copy.
- KTD-5. "The daemon's own child" means a process whose ppid chain reaches the daemon's pid before reaching an agent root, using the resource monitor's existing process attribution (`process-attribution.ts`). It does not mean matching on command names.
- KTD-6. The cooldown is in-memory, keyed by workspace id and reason, and cleared on restart, like the janitor's other per-sweep memory. A workspace whose facts change (new activity, process gone) is eligible again at once.

---

## Implementation Units

### U1. `createdBy` on workspace records

**Requirements:** R1, R2; KTD-1, KTD-2, KTD-3.

**Files:**

- `packages/server/src/server/workspace-registry.ts` and its test
- `packages/server/src/server/workspace-auto-pin.ts`, or the shared caller check it uses
- the creation paths: `workspace.create.request` and `create_agent_request` handling, the MCP `create_workspace` tool, schedules, remediation and Hub
- `packages/protocol/src/messages.ts` (optional field, COMPAT tag) and the feature flag; `npm run build:client` after

**Test scenarios:**

- An app create with no caller gives `person`.
- An MCP `create_workspace` from an agent gives `agent`.
- A CLI call with `PASEO_AGENT_ID` gives `agent`.
- A schedule run and a remediation fixer give `agent`.
- Backfill: a workspace whose agents carry `paseo.parent-agent-id` becomes `agent`; one with only an unlabelled agent becomes `person`; a stored value is never changed.
- An old client parses the new descriptor, and a new client parses an old one.

### U2. Sidebar section

**Requirements:** R3; KTD-4.

**Files:**

- `packages/app/src/components/sidebar/sidebar-projection.ts` and its test
- the sidebar group rendering and collapse persistence, wherever the existing collapsible groups live
- a browser or component test per `docs/testing.md`

**Test scenarios:**

- Person and agent workspaces partition correctly in both group modes.
- A missing `createdBy` counts as person.
- A manually pinned agent workspace shows in Pinned and not in the agent section.
- An agent with a pending permission puts an attention dot on the collapsed header.
- The collapsed state survives a reload.

**Verification:** screenshots of the sidebar at desktop and compact widths with fixture data, per `docs/qa.md`.

### U3. Sweep starvation fixes

**Requirements:** R4, R5; KTD-5, KTD-6.

**Files:**

- `packages/server/src/server/agent-done-janitor.ts` (the process-inside check near "a process runs inside it", the budget accounting) and its test
- `packages/server/src/server/agent/workspace-sweep-detector.ts` if the facts it reads change

**Test scenarios:**

- A `tea pr list` whose parent is the daemon pid does not keep a workspace.
- A `bun` started by an agent's shell still keeps it.
- A workspace kept for an unbacked ignored path is skipped for 6 hours and spends no budget; a sweep with 12 candidates, 3 of them cooled down, attempts the other 9.
- New activity in a cooled-down workspace makes it eligible again.

### U4. The `agent-done` rule, and docs

**Requirements:** R6.

**Files:**

- `packages/server/src/server/agent/workspace-sweep-detector.ts` and its test
- `docs/done-janitor.md`: the rule table, the `createdBy` paragraph, the cooldown, and the daemon-children exclusion, integrated in place
- the sidebar's owning doc, if one describes grouping; otherwise `docs/design.md` only if it lists sidebar sections

**Test scenarios:**

- An agent-made workspace whose last agent was archived 61 minutes ago, with nothing running, is archived by `agent-done`.
- The same at 59 minutes is kept.
- A person-made workspace follows `idle`/`empty` as today.
- An agent-made Paseo worktree still goes through the git gate and snapshot before its directory is deleted.

---

## Verification Contract

- Targeted vitest only: `nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2` from the owning package. Check `uptime` first and wait while load1 > 16. Never a full suite, never e2e, never a native build.
- `npm run build:client` / `build:server` before cross-package type errors; then typecheck and the repo's npm format and check scripts on changed files.
- Never touch the live daemon on 6767 or write under `~/.paseo`; reading `~/.paseo/projects/workspaces.json` for analysis is fine.

## Definition of Done

- R1–R6 met, with tests passing, docs updated in place, and screenshots of the sidebar section.
- After deploy, the sidebar's main list holds Tyler's own workspaces, and within a day of sweeps the unarchived agent-workspace count falls from about 100 to the few with live agents.
