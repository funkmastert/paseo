---
title: "feat: Completion state — server (set_completion_state MCP tool)"
date: 2026-10-13
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Completion state — server

## Summary

Add a `set_completion_state` agent MCP tool that writes/clears three labels (`paseo.completion`, `paseo.completion-note`, `paseo.completion-at`) encoding whether an agent is `ready-to-merge` or `done`. Verify the claim before accepting it, auto-clear the labels on new human input, write the agent-facing prompt text, and document the contract. This is the server half of a two-slice feature; the app slice (sidebar icons) runs in parallel against the same label contract and is out of scope here — do not touch `packages/app`.

Origin: `~/bozeo-ops/briefs/completion-state.md` ("Server slice" + "Both slices" sections). RAPID MODE; no user confirmation gates fire in this run — defaults are chosen and named below, per the brief's "never ask Tyler anything."

## Problem Frame

Tyler wants a third status signal on an agent's session row beyond question/working/idle: "ready to merge" (PR open, green, waiting) and "done" (merged/deployed, nothing left). The daemon already flows arbitrary labels to every client in the agent snapshot, so the state needs no protocol change — only a trusted way for an agent to claim it, a refusal path when the claim is false, and a way for the claim to expire automatically when new work arrives.

## Requirements

- R1. A new MCP tool `set_completion_state` writes or clears `paseo.completion` / `paseo.completion-note` / `paseo.completion-at` through the same label-write path `update_agent` uses.
- R2. With no `agentId`, the tool targets the caller. A parent may target its own child by `agentId`; anyone else is refused.
- R3. `ready-to-merge` and `done` are refused with an actionable reason when: a pending permission/question is open, any child agent is running or initializing, or the worktree has work that exists nowhere else. `done` additionally requires the branch be merged into the remote base branch.
- R4. The labels auto-clear the moment the agent receives a new human prompt (a non-system-injected `user_message`); system envelopes (heartbeats, finish reports, the done janitor's own question) do not clear them.
- R5. Agents are told how and when to call the tool via new `daemon.appendSystemPrompt` text (COMPLETION STATE (Bozeo)), handed to Tyler in the final message, not written into `~/.paseo`. A one-line pointer is added to the account-pool plugin's leader policy injection if there's a natural spot.
- R6. `docs/completion-state.md` documents the contract; `CLAUDE.md`'s docs table and `docs/done-janitor.md` each get one line linking to it.
- R7. Tests cover the tool's happy paths, every refusal reason, the git-gate cases against a real temp repo, and auto-clear vs. system-envelope non-clear.

## Key Technical Decisions

- **KTD1 — "pending permission or open question" is one check.** This daemon gates `AskUserQuestion` through the same pending-permission mechanism as any other tool call (`docs/ask-user-question.md`; the UI's "question card" is a permission response). `DoneJanitorAgentView.pendingPermissionCount` (`packages/server/src/server/agent-done-janitor.ts:2354`, sourced from `agent.pendingPermissionCount` on the live `ManagedAgent`) already models exactly this. No separate "open question" field exists, so the refusal check is `pendingPermissionCount > 0`, not two checks.
- **KTD2 — children check walks the whole subtree, not just direct children.** The brief says "child agents"; the done janitor's own "finished" semantics (`packages/server/src/server/agent/done-janitor-detector.ts:163` `treeNotDoneReason`) walk every descendant, because a live grandchild means work is not actually finished either. Reuse that shape (parent pointer via `getParentAgentIdFromLabels`, cycle-safe BFS) rather than the narrower literal reading.
- **KTD3 — reuse `checkWorktreeDeletionSafety` unchanged for the "work exists nowhere else" half.** `packages/server/src/server/done-janitor-worktree.ts:91` already answers exactly this: no uncommitted/untracked files, and every commit reachable from a remote-tracking ref or the recorded local base branch. That is sufficient for `ready-to-merge` as-is.
- **KTD4 — `done`'s extra "merged into remote base" check is new code, co-located in the same file.** `checkWorktreeDeletionSafety`'s reachability check accepts _any_ remote-tracking ref or the local base branch — enough to prove nothing is lost on delete, not enough to prove a PR merged. Add a sibling exported function, `checkMergedIntoRemoteBase`, in `done-janitor-worktree.ts` (same read-only git helpers, no new gate file) that checks HEAD's ancestry against `refs/remotes/*/<baseBranch>` specifically.
- **KTD5 — non-worktree or unresolvable workspaces allow through, per the brief.** `local_checkout`/`directory` workspaces, or a missing `workspaceRegistry` dependency, skip the git gate entirely and the response note says so, matching "if the gate can't tell... allow it and say so."
- **KTD6 — widen `AgentManager.setLabels`'s type, don't add a second write path.** `writeLabels`/`applyLabelPatch` (`agent-manager.ts:1229`, `:3887`) already treat `null` as "delete this key" at runtime; only the public `setLabels(agentId, labels: Record<string, string>)` signature (`:3880`) is narrower than it needs to be. Export the existing internal `AgentLabelPatch` type (`Record<string, string | null>`) and widen `setLabels`'s parameter to it — a one-line, backward-compatible change (`Record<string,string>` already satisfies `AgentLabelPatch`). This _is_ "the same path `update_agent` labels use," generalized to support clearing, rather than a second label-write mechanism.
- **KTD7 — auto-clear hooks into the existing timeline-event discriminator, not a new listener.** `AgentManager.onStreamTimelineEvent` (`agent-manager.ts:6633`) already branches on exactly "is this a live, newly-arrived, non-replayed `user_message` that is not a system-injected envelope" (the `isSystemInjectedEnvelope` early-return at `:6641` and the `fromHistory` early-return at `:6657`); by the time execution reaches `:6668`, every case the brief wants excluded is already excluded. Clear the three labels there rather than adding a second dispatch hook.

## High-Level Technical Design

```
set_completion_state(state, note?, agentId?)
  │
  ├─ resolve target = agentId ?? callerAgentId
  │     agentId given & target≠caller & getParentAgentIdFromLabels(target.labels)≠caller → throw (refused)
  │
  ├─ state === "clear"  → agentManager.setLabels(target, { completion:null, note:null, at:null }); return
  │
  └─ state === "ready-to-merge" | "done"
        ├─ target.pendingPermissionCount > 0?                        → throw
        ├─ any descendant lifecycle running|initializing?            → throw
        ├─ resolve workspace(target.workspaceId)
        │     not found / not "worktree" kind                       → skip gate, note "not a worktree, allowing"
        │     else → checkWorktreeDeletionSafety(cwd, baseBranch)
        │             not safe (dirty/unpushed/locked/etc.)          → throw with its reason
        ├─ if state === "done":
        │     checkMergedIntoRemoteBase(cwd, baseBranch)
        │       merged === false                                     → throw with its reason
        │       merged === null (can't tell)                         → allow, note why
        └─ agentManager.setLabels(target, { completion:state, note, at: now }); return
```

## Implementation Units

### U1. Protocol label constants

**Goal:** Give the three completion-state labels stable, typed names other code (this tool, the auto-clear hook, later the app slice) can import, matching the existing `agent-labels.ts` style.

**Requirements:** R1

**Dependencies:** none

**Files:**

- `packages/protocol/src/agent-labels.ts` — modify
- `packages/protocol/src/agent-labels.test.ts` — modify

**Approach:** Add alongside `PARENT_AGENT_ID_LABEL` etc.:

- `export const COMPLETION_LABEL = "paseo.completion";`
- `export const COMPLETION_NOTE_LABEL = "paseo.completion-note";`
- `export const COMPLETION_AT_LABEL = "paseo.completion-at";`
- `export const COMPLETION_STATES = ["ready-to-merge", "done"] as const;` and `export type CompletionState = (typeof COMPLETION_STATES)[number];`
- A small reader, `getCompletionStateFromLabels(labels): CompletionState | null`, mirroring `getParentAgentIdFromLabels`'s shape (validates the value is one of `COMPLETION_STATES`, else null) — the app slice and this tool's own tests both want it.

**Patterns to follow:** `getParentAgentIdFromLabels` (`agent-labels.ts:54`) for the reader shape; `getMigratedToFromLabels` for the null-safe trim pattern.

**Test scenarios:**

- `getCompletionStateFromLabels` returns `"ready-to-merge"`/`"done"` when the label is set to that exact value.
- Returns `null` when the label is absent, empty, or an unrecognized value (e.g. `"finished"`).
- Happy path: constants exist and are the literal strings `"paseo.completion"` / `"paseo.completion-note"` / `"paseo.completion-at"` (the app slice depends on this exact contract).

**Verification:** `npx vitest run packages/protocol/src/agent-labels.test.ts`.

---

### U2. `checkMergedIntoRemoteBase` — the `done`-only git check

**Goal:** Answer "is this worktree's HEAD merged into its remote base branch" without duplicating `checkWorktreeDeletionSafety`'s existing deletion-safety semantics.

**Requirements:** R3 (KTD4)

**Dependencies:** none

**Files:**

- `packages/server/src/server/done-janitor-worktree.ts` — modify (add export)
- `packages/server/src/server/done-janitor-worktree.test.ts` — modify (add cases)

**Approach:** Add an exported function next to `checkWorktreeDeletionSafety`/`readReachability`, reusing `createReadOnlyGit`/`realpathOrSelf`/`READ_ONLY_GIT_ENV` already in the file:

```ts
export type MergedIntoRemoteBase =
  | { merged: true }
  | { merged: false; reason: string }
  | { merged: null; reason: string }; // can't tell -> caller allows
```

Logic: if `baseBranch` is null, return `{ merged: null, reason: "no base branch recorded" }`. Otherwise resolve HEAD; list candidate refs via `git for-each-ref --format=%(refname) refs/remotes/*/<baseBranch>`; if none exist, `{ merged: null, reason: "no remote base branch <baseBranch> found" }`. Otherwise `merged: true` if HEAD is an ancestor of _any_ candidate ref (`git merge-base --is-ancestor HEAD <ref>`, exit 0), else `{ merged: false, reason: "<branch> is not yet merged into <remote-ref>" }` naming the first candidate checked. Any git command failure is "can't tell" (`merged: null`), never "not merged" — same doubt-keeps-safe convention as the rest of the file.

**Technical design:** Directional only — mirror `readReachability`'s shape (`done-janitor-worktree.ts:237`) but target a specific ref pattern instead of `--remotes`.

**Patterns to follow:** `readReachability` (same file) for the git-call shape and doubt-handling; `createReadOnlyGit`'s null-on-failure contract.

**Test scenarios** (temp git repo + bare remote, same helpers as `done-janitor-worktree.test.ts:35-71`):

- A worktree branch whose commits are all reachable from `origin/main` after a merge commit lands on `origin/main` → `merged: true`.
- A worktree branch pushed to `origin/feature` but not yet merged into `origin/main` → `merged: false`, reason names the branch and the base.
- A worktree with no `baseBranch` recorded → `merged: null`.
- A worktree whose remote has no branch matching `baseBranch` (e.g. base branch never pushed) → `merged: null`.
- A worktree with local commits never pushed anywhere → `merged: false` (not an ancestor of the remote ref).

**Verification:** `npx vitest run packages/server/src/server/done-janitor-worktree.test.ts`.

---

### U3. Widen `AgentManager.setLabels` to accept label clears

**Goal:** Let callers clear specific label keys through the exact path `update_agent` already writes through, without adding a second write mechanism.

**Requirements:** R1 (KTD6)

**Dependencies:** U1 (for the label constants used in its test)

**Files:**

- `packages/server/src/server/agent/agent-manager.ts` — modify
- `packages/server/src/server/agent/agent-manager.test.ts` — modify (or nearest existing label test file — confirm exact test file at implementation time)

**Approach:** Export the existing `AgentLabelPatch` type (`agent-manager.ts:1011`, currently module-private) and change `setLabels`'s parameter type from `Record<string, string>` to `AgentLabelPatch` (`agent-manager.ts:3880`). No behavioral change: `writeLabels`/`applyLabelPatch` already delete a key when its patch value is `null` (`agent-manager.ts:1236`) and already refuse `PROTECTED_LABEL_KEYS` (`JEV_TOOLS_LABEL`, `CODEX_GUARDED_LABEL`) regardless of caller — completion-state labels are not protected, so this is a pure capability unlock for existing, tested logic.

**Test scenarios:**

- `setLabels(agentId, { "paseo.completion": "done" })` sets the label (existing behavior, regression check).
- `setLabels(agentId, { "paseo.completion": null })` removes a previously-set label, on both a live agent and a stored (non-live) one.
- `setLabels` on a protected key (e.g. `paseo.jev-tools`) is still silently ignored (regression check — `PROTECTED_LABEL_KEYS` still applies after the signature widening).

**Verification:** `npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t "setLabels"` (or the matching existing test file/describe block found at implementation time).

---

### U4. `set_completion_state` MCP tool + verification

**Goal:** The tool itself: resolve target, enforce the parent-on-child permission rule, verify for `ready-to-merge`/`done`, write or clear labels.

**Requirements:** R1, R2, R3

**Dependencies:** U1, U2, U3

**Files:**

- `packages/server/src/server/agent/completion-state-command.ts` — create
- `packages/server/src/server/agent/completion-state-command.test.ts` — create
- `packages/server/src/server/agent/tools/paseo-tools.ts` — modify (register the tool near `update_agent`, `archive_agent`)
- `packages/server/src/server/agent/tools/paseo-tools.test.ts` — modify (or nearest existing tool-catalog test — confirm at implementation time)

**Approach:** New pure-ish command module (mirrors `lifecycle-command.ts`'s dependency-injected style) exposing `setCompletionStateCommand(dependencies, input)`:

```ts
interface CompletionStateCommandDependencies {
  agentManager: Pick<AgentManager, "getAgent" | "listAgents" | "setLabels">;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
  checkWorktreeDeletionSafety?: typeof checkWorktreeDeletionSafety; // injectable for tests
  checkMergedIntoRemoteBase?: typeof checkMergedIntoRemoteBase;
}
interface SetCompletionStateInput {
  callerAgentId: string;
  agentId?: string;
  state: "ready-to-merge" | "done" | "clear";
  note?: string;
}
```

Resolution order:

1. `target = input.agentId ?? input.callerAgentId`.
2. If `input.agentId` and `target !== callerAgentId`: load target agent; if missing, throw `Agent ${target} not found`; if `getParentAgentIdFromLabels(target.labels) !== callerAgentId`, throw `Refused: ${callerAgentId} is not the parent of ${target}`.
3. `state === "clear"`: `agentManager.setLabels(target, { [COMPLETION_LABEL]: null, [COMPLETION_NOTE_LABEL]: null, [COMPLETION_AT_LABEL]: null })`; return `{ success: true, state: null, note: null, completionAt: null }`.
4. Otherwise, verify in this order, throwing a descriptive `Error` on the first failure (matches existing tool convention, e.g. `paseo-tools.ts:1882`'s thrown errors, which the MCP SDK turns into an `isError` tool result):
   - `target.pendingPermissionCount > 0` → `Refused: a pending permission or question is still open`.
   - Any agent whose parent chain (BFS via `getParentAgentIdFromLabels`, cycle-guarded like `done-janitor-detector.ts:129`'s `listDescendants`) reaches `target.id` has `lifecycle === "running" || "initializing"` → `Refused: child agent ${id} is still ${lifecycle}`.
   - Resolve `workspace = workspaceRegistry?.get(target.workspaceId)`. If absent or `workspace.kind !== "worktree"`: skip to step 5, `gateNote = "not a worktree, allowing"`.
   - Else `safety = checkWorktreeDeletionSafety({ worktreePath: workspace.cwd, baseBranch: workspace.baseBranch })`. If `!safety.safe`: `Refused: ${safety.reason}`.
   - If `state === "done"`: `merged = checkMergedIntoRemoteBase({ worktreePath: workspace.cwd, baseBranch: workspace.baseBranch })`. If `merged.merged === false`: `Refused: ${merged.reason}`. If `merged.merged === null`: `gateNote = merged.reason` (allow, say why).
5. On success: `agentManager.setLabels(target, { [COMPLETION_LABEL]: state, [COMPLETION_NOTE_LABEL]: input.note ?? null, [COMPLETION_AT_LABEL]: new Date().toISOString() })`; return `{ success: true, state, note: input.note ?? null, completionAt, gateNote }`.

Register in `paseo-tools.ts` next to `update_agent` (`:2410`):

```ts
registerTool(
  "set_completion_state",
  {
    title: "Set completion state",
    description:
      "Mark this agent (or your own child) ready-to-merge or done, or clear the state. Verified before being accepted.",
    inputSchema: {
      state: z.enum(["ready-to-merge", "done", "clear"]),
      note: z.string().trim().max(200).optional(),
      agentId: z
        .string()
        .optional()
        .describe("Target a child you created. Omit to target yourself."),
    },
    outputSchema: {
      success: z.boolean(),
      state: z.enum(["ready-to-merge", "done"]).nullable(),
      note: z.string().nullable(),
      completionAt: z.string().nullable(),
    },
  },
  async ({ state, note, agentId }) => {
    if (!callerAgentId) throw new Error("set_completion_state requires a caller agent");
    const result = await setCompletionStateCommand(
      { agentManager, workspaceRegistry: options.workspaceRegistry },
      { callerAgentId, agentId, state, note },
    );
    return { content: [], structuredContent: ensureValidJson(result) };
  },
);
```

**Patterns to follow:** `lifecycle-command.ts`'s dependency-injected command functions; `update_agent`/`archive_agent` registration shape (`paseo-tools.ts:2360-2450`); `getParentAgentIdFromLabels` + cycle-safe BFS from `done-janitor-detector.ts:129`.

**Test scenarios:**

- Happy path — `ready-to-merge` on self: no pending permission, no running children, clean pushed worktree → labels set, `completionAt` is a fresh ISO timestamp.
- Happy path — `done` on self: same, plus worktree merged into remote base → labels set.
- Happy path — parent sets `ready-to-merge` on its own child (`agentId` given, caller is the parent) → succeeds.
- `clear` always succeeds regardless of pending permission/children/git state, and removes all three labels.
- Refusal: caller passes `agentId` for an agent that is not its child (parent label points elsewhere, or is null) → throws naming the refusal, no labels written.
- Refusal: target agent has `pendingPermissionCount > 0` → throws, no labels written.
- Refusal: a direct child is `running` → throws naming the child.
- Refusal: a grandchild (child-of-child) is `initializing` → throws (covers KTD2's whole-subtree choice).
- Refusal: worktree has uncommitted files → throws with `checkWorktreeDeletionSafety`'s own reason text.
- Refusal: worktree has commits on no remote branch → throws with the reason text.
- `done`-only refusal: worktree is clean and pushed but not merged into the remote base → throws, distinct from the `ready-to-merge` case which would have succeeded with the same tree state.
- Non-worktree workspace (`local_checkout`/`directory`, or `workspaceRegistry` absent) → succeeds with a note that the git gate was skipped, for both states.
- Integration: a turn calling `set_completion_state` on itself with no `agentId` resolves to the caller even though `agentId` is technically optional in the schema (schema-level smoke test alongside the handler tests).

**Verification:** `npx vitest run packages/server/src/server/agent/completion-state-command.test.ts packages/server/src/server/agent/tools/paseo-tools.test.ts`.

---

### U5. Auto-clear on new human input

**Goal:** Clear all three labels the moment the agent receives a new, non-system-injected prompt.

**Requirements:** R4 (KTD7)

**Dependencies:** U1, U3

**Files:**

- `packages/server/src/server/agent/agent-manager.ts` — modify
- `packages/server/src/server/agent/agent-manager.test.ts` — modify (or nearest existing timeline-dispatch test file — confirm at implementation time)

**Approach:** In `onStreamTimelineEvent` (`agent-manager.ts:6633`), after the existing `isSystemInjectedEnvelope` and `fromHistory` early returns have already run (so this point is only reached for a live, new, non-system `user_message`), extend the existing `if (event.item.type === "user_message") { agent.lastUserMessageAt = ...; this.emitState(agent); }` block (`:6669-6672`): before `emitState`, if any of the three completion labels are present on `agent.labels`, apply the clearing patch via the same `writeLabels`/`applyLabelPatch` machinery `setLabels` uses (call `this.writeLabels` directly, since this is inside the class — no need to round-trip through the public `setLabels` method), then let the single `emitState` at the end of the block cover both changes in one push instead of two.

**Test scenarios:**

- An agent with `paseo.completion: "ready-to-merge"` set receives a real (non-system) `user_message` timeline event → all three labels are gone afterward.
- An agent with the labels set receives a system-injected envelope `user_message` (e.g. the done janitor's own question, wrapped in `<paseo-system>`) → labels are unchanged.
- An agent with the labels set replays history (`options.fromHistory: true`) on resume → labels are unchanged (the `fromHistory` branch returns before reaching the clear).
- An agent with no completion labels set receives a new human prompt → no-op, no extra `writeLabels` call (avoid a spurious persist/emit when there's nothing to clear).
- A non-`user_message` timeline event (e.g. `assistant_message`) never triggers the clear path.

**Verification:** `npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t "completion"` (or the matching test file found at implementation time).

---

### U6. Agent-facing prompt text + plugin policy pointer

**Goal:** Tell agents when and how to use the tool, in Tyler's voice/format for `daemon.appendSystemPrompt`, and add a one-line pointer where leader policy is already injected.

**Requirements:** R5

**Dependencies:** U4 (the tool must exist for the text to reference correctly)

**Files:**

- `plugins/claude-account-pool/server/compound-policy.ts` — modify
- `plugins/claude-account-pool/server/compound-policy.test.ts` — modify (regression only — assertions compare against the exported constant, not a hardcoded string, so no existing assertion needs to change; add one asserting the new line is present)

**Approach:** Append one line to the `COMPOUND_POLICY_NOTICE` array (`compound-policy.ts:45-52`) — a pointer, not the full rule (the full rule lives in `daemon.appendSystemPrompt`, which Tyler owns and adds separately, per the brief):

```ts
"Call set_completion_state (ready-to-merge/done) right before your final message once there's nothing left to do — see COMPLETION STATE (Bozeo) in your system prompt for when each state applies.",
```

Write the full `daemon.appendSystemPrompt` rule text as a deliverable of this plan (not committed to `~/.paseo` — handed to Tyler in the final message and in `docs/completion-state.md`), named `COMPLETION STATE (Bozeo)`, matching the terse all-caps-label style of the other rules already in his config (e.g. `LEAKED KEYS:`, `BUG-FIX PR BATCHING:`):

> **COMPLETION STATE (Bozeo):** call the `set_completion_state` MCP tool right before your final message once there is nothing left to do, so your session row shows it without Tyler opening it. Call it with `state:"ready-to-merge"` when the work is finished, every question is resolved, tests and CI are green, and a PR is open waiting only on the merge. Call it with `state:"done"` when all of that holds AND the PR (or PRs) are merged and any deploy is done — nothing left, the session is ready to archive. It clears itself the moment you receive new work (a real prompt, not a heartbeat or system check), so set it again each time you finish again. Pass `note` (<=200 chars) for a one-line summary like "PR #41 merged, deployed"; pass `agentId` only to set it on your own child, never on yourself through another agent. The daemon refuses the call with a reason if a question or permission is still open, a child is still running or initializing, or your worktree has work that exists nowhere else (uncommitted changes, or commits unpushed/unmerged) — fix that first and call it again.

**Test scenarios:**

- `COMPOUND_POLICY_NOTICE` contains the new pointer line (string containment, same style as existing assertions at `compound-policy.test.ts:93-97`).
- Existing `toBe(COMPOUND_POLICY_NOTICE)` equality assertions keep passing unmodified (they compare against the constant, not a literal — regression check, no code change needed, confirms the test design survives the addition).

**Verification:** `npx vitest run plugins/claude-account-pool/server/compound-policy.test.ts`.

---

### U7. Documentation

**Goal:** A short, linked doc for the contract; one-line pointers from the two docs that should send readers to it.

**Requirements:** R6

**Dependencies:** U1, U2, U4 (so the doc can cite real label names, the merge check, and the tool)

**Files:**

- `docs/completion-state.md` — create
- `CLAUDE.md` — modify (docs table row)
- `docs/done-janitor.md` — modify (one sentence)

**Approach:** `docs/completion-state.md` sections, short, in the repo's doc voice (plain, second person, state-the-rule):

- What the two states mean (`ready-to-merge` / `done`), one line each.
- The contract: the three labels, their exact keys, `completion-note`'s 200-char cap.
- Verification: what's checked for each state, and that `done` additionally requires the merge check; what "can't tell" means and that it allows through.
- Auto-clear: fires on any non-system-injected `user_message`, not on heartbeats/system envelopes.
- How agents are told: points at the `COMPLETION STATE (Bozeo)` prompt text and names where it lives (`daemon.appendSystemPrompt`, not `~/.paseo`).

`CLAUDE.md`: one row in the docs table, alphabetically/contextually placed near `docs/done-janitor.md`'s row.

`docs/done-janitor.md`: one sentence, placed near "What 'finished' means" or "Not automated" — a declared `done` is a strong hint the work is finished, but the janitor does not read the label or act on it yet (avoids implying the two systems are already wired together).

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** Manual read-through; confirm the CLAUDE.md table row renders and the done-janitor.md link resolves.

## Scope Boundaries

**In scope:** everything under "Server slice" and "Both slices" in the brief, for `packages/server`, `packages/protocol`, and `plugins/claude-account-pool` only.

**Out of scope (the app slice, running in parallel):** anything in `packages/app` — sidebar icons, pinned-grid dot, i18n strings, precedence logic, `pickPinnedWorkspaceAgentId`. Do not touch these files even incidentally.

**Deferred to follow-up work:**

- Wiring `AgentDoneJanitor` to read or act on a declared `done` label (explicitly called out as not-yet in `docs/done-janitor.md`'s new sentence).
- Any UI for setting/clearing the label by hand (the brief's `paseo.keep`-style manual label-set via `update_agent` already works generically; no new affordance requested).

## Verification Contract

- `npm run typecheck` and `npm run lint -- <touched files>` clean.
- `npm run format -- <touched files>` applied.
- Every test file touched or newly created passes via `npx vitest run <file>`, run individually (never the full suite, per repo rules).
- `npm run build:server` (via `heavy.sh`) succeeds before and after, confirming no cross-package type breakage from the protocol export (U1) or the `agent-manager.ts` export (U3).

## Definition of Done

- `set_completion_state` registered, callable for all three states plus `clear`, with every refusal reason from R3 tested against a real temp git repo for the git-gate cases.
- Auto-clear verified against both a real and a system-injected `user_message`.
- `AgentManager.setLabels` accepts clears; `update_agent`'s existing behavior is an unmodified regression-tested subset.
- `COMPOUND_POLICY_NOTICE` carries the pointer line; the full `COMPLETION STATE (Bozeo)` text is ready to hand to Tyler.
- `docs/completion-state.md` exists and is linked from `CLAUDE.md` and `docs/done-janitor.md`.
- No changes under `packages/app`, `package-lock.json`, or any `package.json`.
