---
title: JEV Dashboard Activity - Plan
type: fix
date: 2026-10-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# JEV Dashboard Activity - Plan

## Goal Capsule

- **Objective:** every JEV feature Tyler kept on does real work and shows it on the JEV dashboard. Title refresh records what it already does, agent tools get discovered, spawn hint judges labelled spawns in shadow, and compaction timing exists.
- **Authority:** this plan, then `docs/jev.md` (Feature 2, Features 4–6, Feature 9, Feature 17, Savings, The JEV dashboard), then `docs/leader-compaction.md`, `CLAUDE.md`.
- **Execution profile:** two PRs from two workers. PR A (U1–U3) is a batch of small fixes. PR B (U4) is the compaction-timing track, kept separate so it can be reverted on its own: it changes when leaders compact.
- **Stop conditions:** stop and report if a fix would change a live (non-shadow) behavior beyond what is written here, or if feature 9 cannot stay synchronous in the monitor and planner.
- **Tail ownership:** workers commit locally and do not push or restart any daemon. The leader reviews, opens the PRs, merges, stages and relaunches.

---

## Product Contract

### Problem Frame

Diagnosis (`~/bozeo-ops/briefs/jev-diag-*.md`, local) found that five of the dashboard's ten features show nothing. Title refresh made 185 answered JEV calls that never reached the savings ledger. Agent tools are registered for half the fleet, but Claude Code defers their schemas and nothing tells an agent they exist: zero calls in 760 sessions. Spawn hint only judges unlabelled children, and the fleet's model policy labels every spawn, so it never asks. Compaction timing was designed but never built. Away reply stays dormant by design while Tyler is active, and stays that way.

### Requirements

- R1. Each answered title-refresh JEV call records a `titleRefresh` involvement in the savings ledger, as `docs/jev.md` already says it should.
- R2. An agent created with JEV agent tools learns at creation that they exist and when to reach for them; agents in the control arm learn nothing.
- R3. When a child is created with a declared `paseo.task-class`, spawn hint asks JEV in shadow what the class should be, records the answer and the would-have difference, and never changes the label, model or thinking.
- R4. Compaction timing runs as Feature 9 in `docs/jev.md` describes: an async advisor after each leader turn above `considerAtTokens`, verdicts the planner reads, and a cut point for `/compact`. It records its involvements in the savings ledger.
- R5. The dashboard shows each feature's real state; no feature reads as enabled-but-silent because its code is missing.

### Scope Boundaries

- Away reply's presence gate and company-code rule do not change (Tyler, 2026-10-08).
- No feature flips from shadow or dry run to live; that stays Tyler's config edit (D6).
- Leader compaction stays in dry run. Feature 9 records shadow verdicts against it; turning compaction on is a separate decision.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. Title refresh records through the existing `jev.savings.record`, beside its `jev.decisions.record` call, with no token claim (the pricing case in `savings-formulas.ts` already treats it as an involvement).
- KTD-2. Agent-tools discovery is one short line injected at create for agents whose `paseo.jev-tools` arm is on, through the same path that injects the spawn hint. It names the tools and the trigger ("before reading a large file or running an exploratory command, search tools for `ask_jev`"). Control-arm agents get nothing, so the experiment stays clean.
- KTD-3. Spawn-hint audit is a new `agents.jev.spawnHint.auditDeclared` switch, default on, and always shadow for declared children. A declared label always wins. The router writes the existing jev labels with an applied marker of 0, so `savings-spawn.ts` can price over- and under-labelling the same way it prices unlabelled children. (session-settled: user-directed — chosen over leaving spawn hint to unlabelled children only: Tyler wants JEV used on every spawn.)
- KTD-4. Compaction timing is built to `docs/jev.md` Feature 9 as written: seam, state, questions, thresholds, guards, fail-open and cut point. The one change: it runs whenever leader compaction is enabled, including dry run, so it gathers shadow evidence now. (session-settled: user-directed — chosen over leaving the feature unbuilt.)
- KTD-5. Docs are integrated in place in `docs/jev.md` (each feature's section and the dashboard's state list), not appended.

---

## Implementation Units

### U1. Title refresh writes savings involvements (PR A)

**Goal:** answered title-refresh calls appear on the dashboard.

**Requirements:** R1, R5; KTD-1.

**Files:** `packages/server/src/server/workspace-title-refresh-jev.ts` and its test; `packages/server/src/server/bootstrap.ts` only if the recorder's dependency type must widen.

**Approach:** widen the recorder's dependency from `Pick<JevService, "decisions">` to include `savings`, and record one involvement per answered call (feature `titleRefresh`, call site, agent and workspace, mode live, decision summary). A `not asked` or failed call records what the other features record for those outcomes.

**Test scenarios:**

- An answered title-refresh decision writes one `titleRefresh` involvement with no token benefit.
- A failed or not-asked call writes the matching non-answered record, or nothing, per the Savings section.
- The decisions log line is unchanged.

**Verification:** after deploy, `~/.paseo/jev/savings.jsonl` gains `titleRefresh` involvements and the dashboard row shows them.

### U2. Agent-tools discovery hint (PR A)

**Goal:** agents with JEV tools find and use them.

**Requirements:** R2, R5; KTD-2.

**Files:** the create-time injection site the spawn hint uses (find it from `docs/jev.md:429` and `plugins/claude-account-pool/server/`); `packages/server/src/server/agent/tools/jev-tools.ts` if the tool descriptions should name their trigger; tests beside each.

**Approach:** when the arm resolves to on, append one line naming the seven tools and when to search for them. Keep tool descriptions specific, because they are what the agent sees after a tool search.

**Test scenarios:**

- An on-arm create carries the hint line; a control-arm create does not.
- An agent without JEV tools at all (provider without MCP, tools not served) gets no hint.

**Verification:** after deploy, a new on-arm agent's first system context contains the line; within a day the audit log shows `agentTools` calls.

### U3. Spawn-hint audit of declared labels (PR A)

**Goal:** JEV judges every labelled spawn in shadow.

**Requirements:** R3, R5; KTD-3.

**Files:** `plugins/claude-account-pool/server/jev-hint.ts` (`planSpawnHint`), `plugins/claude-account-pool/server/role-router.ts` (labels), `packages/server/src/server/jev/config.ts` (`auditDeclared`), `packages/server/src/server/jev/savings-spawn.ts` (pricing declared children), tests beside each; `docs/jev.md` Feature 2.

**Approach:** with `auditDeclared` on, a declared child is asked the existing spawn-hint questions with the declared class in the state, answers are never applied, and the labels record JEV's class and that it was not applied. Leaders (no caller) and schedule-run root creates stay unasked.

**Test scenarios:**

- A declared child with the switch on is asked; its label, model and thinking are unchanged; the jev labels record JEV's class with applied 0.
- The switch off restores today's skip.
- A root create is never asked.
- Savings prices a declared `hard` child that JEV judged `standard` as a would-have saving once the child settles.

**Verification:** after deploy, the audit log shows `spawnHint` calls on labelled spawns and the dashboard row counts involvements.

### U4. Compaction timing (PR B)

**Goal:** Feature 9 built as designed, gathering shadow evidence now.

**Requirements:** R4, R5; KTD-4.

**Files:** create `packages/server/src/server/agent/leader-compaction-timing.ts` and its test; modify `leader-compaction-planner.ts` (+ test), `agent-leader-compaction-monitor.ts` (+ test), `bootstrap.ts` (turn-finished fan-out, monitor options), `packages/server/src/server/jev/service.ts` (drop the hard-coded dormant state), the savings write for `compactionTiming`; `docs/jev.md` Feature 9 and `docs/leader-compaction.md` where they describe the timing.

**Approach:** follow `docs/jev.md` Feature 9 to the letter (seam, state, questions, thresholds, guards, fail-open, cut point) with KTD-4's dry-run change. In dry run the planner's would-start uses the verdict, so the monitor's dry-run log shows when JEV would have started early or deferred. Every answered call records a shadow involvement.

**Test scenarios:** the list in `docs/jev.md` Feature 9 "Tests and verification", plus:

- In leader-compaction dry run the advisor still asks, and the planner's would-start reflects `startEarly` and `defer`.
- Each answered verdict writes a `compactionTiming` shadow involvement.

**Verification:** after deploy, the audit log shows `compactionTiming` calls for leaders above 200K and the dashboard row leaves "Dormant".

---

## Verification Contract

- Targeted vitest only, through `~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2`, from the owning package; never a full suite.
- `npm run build:server` before diagnosing cross-package types; then `npm run typecheck`, `npm run lint -- <files>`, `npm run format:files -- <files>`.
- No worker touches the live daemon on 6767 or `~/.paseo` (reading `~/.paseo/jev/*.jsonl` and `daemon.log` is fine).

## Definition of Done

- R1–R5 met with each unit's tests passing; `docs/jev.md` updated in place.
- After the leader deploys, the audit log and dashboard show activity for title refresh, spawn hint and compaction timing within an hour, and for agent tools within a day.
- No abandoned code remains in either diff.
