---
title: Agents Ask Tyler With AskUserQuestion, Enforced - Plan
type: feat
date: 2026-10-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Agents Ask Tyler With AskUserQuestion, Enforced - Plan

## Goal Capsule

- **Objective:** when an agent Tyler talks to needs his reply, it asks with the AskUserQuestion tool, never with a question or a list of options in plain text at the end of its turn. A daemon check catches a turn that tries to end that way and has the agent ask properly before it stops.
- **Authority:** this plan, then `docs/jev.md` Feature 14 (away reply reads AskUserQuestion), `docs/notification-policy.md`, `CLAUDE.md`.
- **Execution profile:** one worker, U1–U3 in order.
- **Stop conditions:** stop and report if the check could fire on a child agent, block a turn more than once, or delay a turn that asks nothing.
- **Tail ownership:** the worker commits locally and never pushes or restarts the 6767 daemon.

---

## Product Contract

### Problem Frame

On 2026-10-09 Tyler asked to "enforce that the agents always use AskUserQuestion when they need a reply instead of a bulleted list". AskUserQuestion becomes a question card in the Paseo app that Tyler answers from his phone, and the away reply (Feature 14) can answer it while he is out. A text list at the end of a turn makes him type a reply and is easy to miss.

The leader already added an "ASKING TYLER" rule to `daemon.appendSystemPrompt` (live, new sessions; backup `config.json.bak-20261009-askuser`). Policy text alone is advice, so this plan adds the check.

### Requirements

- R1. When a root agent (one with no `paseo.parent-agent-id`) tries to end a turn whose final assistant text asks Tyler for a reply, and that turn made no AskUserQuestion call, the daemon stops the turn from ending. The agent is told: "You ended your turn asking Tyler something in plain text. Ask it with the AskUserQuestion tool instead (load it with ToolSearch "select:AskUserQuestion" if needed): 2–4 options, your recommendation first. Do not repeat the question as text."
- R2. "Asks for a reply" is a narrow, deterministic test on the final assistant text, with code blocks and quoted lines removed. It fires when either holds:
  - the last paragraph contains a sentence ending in `?` that addresses the reader ("should I", "do you want", "want me to", "which", "would you", "can you", "let me know", "your call", "or should");
  - the text has a list of two or more options (bulleted, numbered, or "Option A/B") together with a choice phrase ("which", "pick", "choose", "prefer", "let me know").
- R3. It never fires more than once per turn (Claude's `stop_hook_active`), on a child agent, on a cancelled or failed turn, on a turn that already called AskUserQuestion, or when the check is turned off.
- R4. Each block is logged to `daemon.log` and counted. With `agents.askUserQuestion.mode: "log"` it logs what it would have blocked and lets the turn end. Default is `"enforce"`. `enabled: false` turns it off.
- R5. Non-Claude providers are untouched in v1; their sessions only get the policy text.

### Scope Boundaries

- No JEV call. The test is deterministic, so it costs nothing per turn. A JEV second opinion can follow if the log shows false positives.
- Child agents are not asked to use AskUserQuestion. The policy tells them to decide or report to their leader.
- The app's question card is unchanged.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. **Seam:** a `Stop` hook in the Claude provider's `buildHooks` (`packages/server/src/server/agent/providers/claude/agent.ts`), beside the existing `PreToolUse`/`PostToolUse`/`SubagentStop` observers. It returns `{ decision: "block", reason }` to keep the turn going, which the Claude Agent SDK supports for `Stop`. A block continues the same turn, so the prompt cache stays warm and no new turn starts.
- KTD-2. **Turn text:** the hook reads the turn's final assistant text and its tool calls from the provider's own record of the turn. The `transcript_path` file is never parsed when the session already holds the turn.
- KTD-3. **Detector:** a pure module, `agent/ask-in-text.ts`, with the phrase lists as constants and a table test of positives and negatives, in the catastrophe gate's style. The rule is narrow on purpose: a status report that happens to end with a rhetorical question is a false positive to avoid, so the reader-address phrase list is required for a single `?`.
- KTD-4. **Root only:** the hook is registered only for sessions whose agent has no parent label. The session knows its labels at launch, as the read-check observer does.
- KTD-5. **Config:** `agents.askUserQuestion { enabled?: boolean (true), mode?: "enforce" | "log" ("enforce") }` in `persisted-config.ts`, live-toggleable.

---

## Implementation Units

### U1. The detector

**Requirements:** R2; KTD-3.

**Files:**

- `packages/server/src/server/agent/ask-in-text.ts`
- `packages/server/src/server/agent/ask-in-text.test.ts`

**Test scenarios:**

- Fires on: "Want me to merge it?"; "Should I go with A or B?"; "Which do you prefer:\n1. Rebase\n2. Merge"; "Options:\n- Option A: ...\n- Option B: ...\nLet me know."; "Your call: ship now or wait?".
- Does not fire on: a status report ending "Done."; a rhetorical "Why did it fail? The cache was stale." mid-text; a `?` inside a code block or a quoted line; a bulleted summary with no choice phrase; "Next I'll check X." with no question.

### U2. The Stop hook and config

**Requirements:** R1, R3, R4, R5; KTD-1, KTD-2, KTD-4, KTD-5.

**Files:**

- `packages/server/src/server/agent/providers/claude/agent.ts` (register `Stop` for root sessions; read the turn's text and tool calls)
- `packages/server/src/server/persisted-config.ts` and wiring through `bootstrap.ts`
- tests beside each, including the provider's hook tests

**Test scenarios:**

- A root agent ending "Want me to merge it?" with no AskUserQuestion call is blocked once with the R1 reason, and a second stop in the same turn (`stop_hook_active`) passes.
- The same text from a child agent passes.
- A turn that called AskUserQuestion passes.
- `mode: "log"` logs and passes.
- `enabled: false` registers no Stop hook.
- A cancelled turn passes.

### U3. Docs

**Requirements:** all.

**Files:**

- a new `docs/ask-user-question.md` (what the rule is, the detector's two signals, the config, and how to read the log), with a row in `CLAUDE.md`'s docs table
- a link from `docs/jev.md` Feature 14, where away reply reads AskUserQuestion

**Test expectation:** none — docs only.

---

## Verification Contract

- Targeted vitest only: `nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2` from `packages/server`. Check `uptime` first. Never a full suite, and never e2e (they run the real Claude CLI).
- `npm run build:server` before diagnosing cross-package types; then typecheck and the repo's npm format and check scripts on changed files.
- Never touch the live daemon on 6767 or write under `~/.paseo`.

## Definition of Done

- R1–R5 met, with tests passing and the docs added.
- After deploy, a root agent that ends a turn with a text question gets one block in `daemon.log` and asks again with AskUserQuestion, and children are never blocked.
