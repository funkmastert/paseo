---
title: JEV Read Check Gets The Reader's Own Context - Plan
type: fix
date: 2026-10-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# JEV Read Check Gets The Reader's Own Context - Plan

## Goal Capsule

- **Objective:** JEV's file-read check (Feature 16) is rarely wrong. Today a third of its "would skip" verdicts are false skips, and almost all of them are reads made inside subagents, judged against the wrong task.
- **Authority:** this plan, then `docs/jev.md` Feature 16 ("State and question", "Decision", "Live mode", "Did the agent use it"), `CLAUDE.md`.
- **Execution profile:** one worker, U1–U4 in order.
- **Stop conditions:** stop and report if any change would let the check deny a read it cannot deny today, or would send a file the eligibility rules refuse today.
- **Tail ownership:** the worker commits locally and never pushes or restarts the 6767 daemon.

---

## Product Contract

### Problem Frame

Measured from `~/.paseo/jev/savings.jsonl` on 2026-10-09: 174 settled `would-skip` verdicts, 58 of them false skips (33%). In 53 the agent re-read the file, and in 5 it quoted it. 52 of the 58 are reads inside an in-process subagent:

| Reader     | Files                  | Held | False skips      |
| ---------- | ---------------------- | ---- | ---------------- |
| Subagent   | repo                   | 51   | 30 (37%)         |
| Subagent   | skill docs, CE scratch | 46   | 22 (32%)         |
| Main agent | repo                   | 9    | 6 (40%, small n) |
| Main agent | skill docs, CE scratch | 10   | 0                |

The cause is in the code. `read-check/state.ts` builds `task` from the **parent** agent's title and assignment, and `recent` from the **parent's** timeline tail, even when the hook input carries a subagent's `agent_id`. A subagent told "read the persona file, then the template" is judged against its parent's task, so JEV calls those reads unrelated. Two-thirds of all judged reads come from subagents (3,389 of 4,941).

The check is in shadow (no `agents.jev.readCheck` override in the live config), so no read has ever been blocked. Live mode would deny one read once and let the retry through. A wrong deny an agent trusts is still the failure Tyler is worried about. This plan fixes the context before anyone considers live.

### Requirements

- R1. A read inside a subagent is judged against that subagent's own brief: the subagent tool call's `description` and `prompt`, clipped. The parent's task is kept as one short line of context, and `recent` is the subagent's own recent tool calls.
- R2. A read whose path, or its file name, appears in the reader's brief or task, the current turn's latest prompt, or recent assistant text is `needed` without asking JEV. It gets the new not-asked reason `named`: deterministic, free, and never wrong in the costly direction.
- R3. A main agent's `task` adds the current turn's latest prompt from the leader or Tyler, not only the first assignment. `recent` keeps the search command whose output named the path (`rg`, `grep`, `find`, a Glob), when one did, so JEV sees why the file was opened.
- R4. When the subagent's brief cannot be found, its read is judged as today and marked `brief: missing`. In live mode it can never be denied.
- R5. The dashboard's read-check evidence splits false skips by main agent and subagent, and counts `named` reads, so the effect of this change is visible.

### Scope Boundaries

- No change to live mode's thresholds, the evidence rule, or the shadow default.
- Agents are not asked to narrate every read. Bash reads already carry `description`, and a narration line on every `Read` costs output tokens on every large read. Revisit only if false skips stay above about 15% after this change.
- No change to the eligibility, privacy or D7 rules.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. **Where a subagent's brief comes from.** The parent's subagent tool call (`Agent`/`Task`, `tool_input.description` and `.prompt`) is matched to the subagent by the Claude provider:
  - Prefer `SubagentStart`, which carries `agent_id`. The provider already handles it near `providers/claude/agent.ts`'s SubagentStart branch.
  - Fall back to the SDK's `parent_tool_use_id` on the subagent's stream messages.

  The provider keeps a small per-session map from `agent_id` to brief and exposes it to the observer through the `FileReadObserver` hook input, beside `subagentId`. The brief is clipped to the same 800 characters as `task`.

- KTD-2. **A subagent's `recent`** is a per-`agent_id` ring of the last 16 tool calls the observer's own hooks already see (`Read`, `Bash`, the edit tools), each rendered by `recentLine`. That needs no new hook matcher and no timeline change.
- KTD-3. **The `named` rule** runs after the eligibility checks and before the JEV call. It matches the display path, the path relative to the cwd, and the base name when that is at least 6 characters and not generic (`index.ts`, `README.md`, `SKILL.md` and `package.json` do not count by base name alone). It searches the brief or task, the current turn's latest prompt, and the recent assistant lines. A `named` read is counted, makes no call, and has no validation window.
- KTD-4. **Live safety.** `decideLiveDeny` refuses to deny a subagent read whose brief is `missing`, and a read the `named` rule matched (which never reaches JEV anyway). These are added to the deny conditions in `read-check/decision.ts`.
- KTD-5. **State budget.** `task` grows to brief, then parent line, then latest prompt, within the existing 10,000-byte cap. The excerpt still shrinks first, then `recent`, as today.

---

## Implementation Units

### U1. Subagent brief and recent calls

**Goal:** subagent reads are judged against the subagent's own work.

**Requirements:** R1, R4; KTD-1, KTD-2, KTD-5.

**Files:**

- `packages/server/src/server/agent/providers/claude/agent.ts` (the brief map; pass it with the hook input)
- `packages/server/src/server/jev/read-check/observer.ts` (per-subagent recent ring; brief into the state)
- `packages/server/src/server/jev/read-check/state.ts` (task assembly)
- tests beside each, including `agent.read-check.test.ts` and `state.test.ts`

**Test scenarios:**

- A subagent's read state carries the subagent's description and prompt as `task`, the parent title as one line, and its own recent calls, not the parent's tail.
- A main agent's read state is unchanged except for U3.
- An unknown `agent_id` gives `brief: missing`, and the read is judged as today.
- Two concurrent subagents keep separate briefs and rings.
- The ring is dropped when the subagent ends.

### U2. The `named` rule

**Goal:** reads the agent was told about, or just talked about, are never would-skips.

**Requirements:** R2; KTD-3.

**Files:**

- `packages/server/src/server/jev/read-check/observer.ts`
- a new `packages/server/src/server/jev/read-check/named.ts` and its test
- `packages/server/src/server/jev/contract.ts` (`JevNotAskedReason` gains `named`), plus the protocol enum only if the reason crosses the wire; tag it COMPAT if it does

**Test scenarios:**

- The brief says "read docs/plans/x-plan.md": that read is `named`, and no JEV call is made.
- The base name `DealProfileScreen.swift` appears in recent assistant text: `named`.
- The base name `index.ts` alone does not match. A full relative path containing it does.
- A path mentioned only inside the file's own excerpt does not count.

### U3. Main-agent turn context

**Goal:** a main agent's read is judged against what it was asked this turn.

**Requirements:** R3; KTD-5.

**Files:**

- `packages/server/src/server/jev/read-check/state.ts`, `observer.ts`
- tests beside each

**Test scenarios:**

- A leader that received a new prompt mid-session has it in `task`, after the assignment.
- The search command that printed the path stays in `recent` even when 16 later rows would push it out, as long as it is in the current turn.
- The state stays under 10,000 bytes, with the excerpt shrinking first.

### U4. Live safety and evidence split

**Goal:** a brief-less subagent read can never be denied, and the dashboard shows the split.

**Requirements:** R4, R5; KTD-4.

**Files:**

- `packages/server/src/server/jev/read-check/decision.ts` and its test
- `packages/server/src/server/jev/savings-formulas.ts` (or wherever `bigWouldSkip` and the false-skip counters live) and its test
- `docs/jev.md` Feature 16: "State and question", "When JEV is asked", "Live mode" and the evidence counters, integrated in place

**Test scenarios:**

- In live mode, a `not_needed` at 0.95 on a subagent read with `brief: missing` is not denied.
- The evidence reports false skips for main agents and subagents separately, and a `named` count.

---

## Verification Contract

- Targeted vitest only: `nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2` from `packages/server`. Check `uptime` first. Never a full suite, and never the `*.e2e.test.ts` latency tests, which run the real Claude CLI.
- `npm run build:server` before diagnosing cross-package types; then `npm run typecheck`, `npm run lint -- <files>`, `npm run format:files -- <files>`.
- Never touch the live daemon on 6767 or write under `~/.paseo`. Reading `~/.paseo/jev/*.jsonl` for analysis is fine.

## Definition of Done

- R1–R5 met, with tests passing and `docs/jev.md` Feature 16 updated in place.
- After deploy, a day of shadow records shows the subagent false-skip rate falling from about 35%. The target is under 15% overall, and the leader rechecks it from `savings.jsonl`.
