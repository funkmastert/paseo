---
title: Remediation ladder — deterministic first, one agent second, a person last
status: landed on multi-account-orchestrator-self-heal-first
branch: multi-account-orchestrator-self-heal-first
date: 2026-09-24
---

# Remediation ladder

Tyler, verbatim: "you send me notifications like 'something is using too much memory' but you should just fix that yourself and only tell me if you cant self manage it (almost should never happen)." And: "i think you need some kind of daemon or cron job that can do some of this automatically and only reaches out to an LLM if it needs to."

## The rule

A monitor that has an automatic remedy runs it and records what it did at level `record` (ledger only, no push). A person is told only when:

- (a) no remedy exists and no agent can help;
- (b) the remedy exists but is disabled or in dry run, so it cannot act;
- (c) the remedy ran, a remediation agent ran, and the condition persists, or the agent reported it could not fix it, or escalation was impossible (disabled, over the daily cap, no usable account).

Rung 3 is one deduped push, `alert` unless the condition says otherwise, that says what was tried.

## The three rungs

1. **Deterministic.** The monitor detects the condition and runs its remedy with no LLM. It reports to the ladder every sweep through `RemediationSink.observe()` (`packages/server/src/server/remediation/contract.ts`).
2. **One bounded agent.** When the remedy is `live` and the condition outlasts its grace window, or there is no remedy but the observation names an `escalation.task`, the ladder creates one agent through the normal create path (`createAgentCommand`, `kind: "mcp"`), so the classifier decides role, model, thinking and account. Labels: `paseo.task-class` (`mechanical` or `standard`, `hard` only when the condition asks), `paseo.budget`, `paseo.remediation: <kind>`, `paseo.remediation-key: <key>`. The prompt carries the evidence and the attempts. There is one agent per key, a cooldown per key, a concurrency cap and a daily cap. The agent ends with one line, `REMEDIATION: FIXED — …` or `REMEDIATION: NOT_FIXED — …`. A fixed agent is archived and recorded; a not-fixed, timed-out, over-budget or errored agent goes to rung 3 and is left unarchived so the push can link to it.
3. **A person.** One push per episode, `dedupeKey: remediation:<key>`.

`remedy: "disabled" | "dry-run"` skips rung 2: the operator opted out of automation. `remedy: "none"` without an `escalation` skips rung 2 as well.

An episode opens on the first active observation (recorded once at `record`) and closes on the first inactive one (recorded at `record` with the attempts). An agent that reports FIXED while the monitor still reports the condition active gets one more grace window, then rung 3, never a second agent inside the cooldown.

## Config

`agents.remediation`, live via `patchDaemonConfig`. Types and defaults: `packages/server/src/server/remediation/config.ts`. Already plumbed through protocol (`MutableRemediationConfigSchema`), `persisted-config.ts` (strict), `config.ts`, `daemon-config-store.ts` (deep merge) and `bootstrap.ts` (`withRemediationConfig`). **Do not add keys to it without telling the leader**: every workstream shares this schema, and conflicting edits to it are the main merge risk.

| Block           | Rung / owner                                |
| --------------- | ------------------------------------------- |
| `remedies`      | rung 1 master switch for the new sweeps     |
| `escalation`    | rung 2                                      |
| `notify`        | rung 3                                      |
| `conditions`    | per-kind overrides (`graceMinutes`, etc.)   |
| `stalledAgents` | the stalled-agent sweep                     |
| `disk`          | disk low / falling fast and growth sampling |
| `workSnapshots` | work-at-risk snapshots                      |

## Workstreams and file ownership

Each workstream is one agent in its own worktree, branched from this branch after the foundation commit. Stay inside your files; if you must touch another workstream's file, keep the edit small and say so in your report.

| Workstream             | Owns                                                                                                                                                                                                                                                                                | Plugs in                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **L — ladder**         | `remediation/ladder.ts` (+ state store, escalation, tests), ladder wiring in `bootstrap.ts`, `docs/remediation.md` (new), the principle in `docs/notification-policy.md` (Levels / "Rank by…" / Adding a sender), `CLAUDE.md` docs-table row                                        | —                                                           |
| **M — monitors**       | `agent-resource-monitor.ts`, `agent-token-burn-monitor.ts` (account pressure), push-level audit of every other sender, `plugins/claude-account-pool/server/notify.ts`, `docs/resource-monitor.md`, `docs/token-burn.md`, the sender-inventory rows in `docs/notification-policy.md` | orphan-build-daemons, system-memory, account-pool-exhausted |
| **D — disk**           | `worktree-disk-monitor.ts`, new `disk-growth-sampler.ts`, on-demand triggers into the done janitor and the artifact janitor, `docs/disk-pressure.md` (new)                                                                                                                          | disk-low, disk-critical, disk-falling                       |
| **W — work snapshots** | new `agent/worktree-snapshot.ts` (implements `WorktreeSnapshotter`), new work-at-risk sweep, `agent-done-janitor.ts` integration (snapshot before any archive or reclaim of a dead agent's worktree), `docs/work-snapshots.md` (new), `docs/done-janitor.md`                        | work-at-risk                                                |
| **S — stalled agents** | new `agent-stall-sweep.ts` (+ detector), any `agent-manager.ts` addition it needs (keep it small), `docs/stalled-agents.md` (new)                                                                                                                                                   | stalled-agent                                               |
| **F — account limit**  | `agent-account-failover-monitor.ts` stranding observation, merges the `flexible-placement` and `failover-return` branches (collapse onto the leader account, return on reset), `docs/account-failover.md`                                                                           | account-pool-exhausted (key `account-failover-stranded`)    |

Shared files everyone may need a few lines in: `bootstrap.ts` (wire your monitor next to its siblings; keep your block contiguous), `CLAUDE.md` docs table (one row per new doc), `docs/notification-policy.md` (inventory rows only, except L). The leader merges and resolves conflicts in these.

Test your monitor against a fake sink that records observations.

### Bootstrap seams

Every workstream that needs the sink adds this exact line, at this exact place in `bootstrap.ts`: immediately before `worktreeDiskMonitor = new WorktreeDiskMonitor({`. Identical additions merge cleanly.

```ts
const remediationSink = createForwardingRemediationSink();
```

Pass `remediationSink` to your monitor. L builds the ladder once the WebSocket server exists and calls `remediationSink.attach(ladder)`.

S takes a `WorktreeSnapshotter`. S wires `UNAVAILABLE_WORKTREE_SNAPSHOTTER`; W replaces it with the real one; the leader resolves that one line at integration.

### Ladder semantics other workstreams rely on

- An agent still running when its episode closes finishes, and its report still counts: NOT_FIXED still reaches rung 3. W relies on this, because it marks snapshots as handed over and reports the condition inactive on the next sweep.
- An observation with `remedy: "none"`, an `escalation`, and grace 0 escalates on the first sweep.
- Rung 3 fires at most once per episode. A new episode for the same key inside the cooldown goes straight to rung 3 without a second agent.

## Things already decided

- Tyler's live config: the reaper is **enabled and live**; the done janitor is live; the artifact janitor is off; account pressure is on at 90%. The pool is `claude` (leader), `claude-personal` (worker, priority 1), `claude-backup` (worker, priority 2).
- Account limits: `AccountFailoverMonitor` is the deterministic rung. Branches `multi-account-orchestrator-flexible-placement` (collapse onto the leader account, one push when no account is left) and `multi-account-orchestrator-failover-return` (return on reset) are in flight in other sessions and conflict with each other in `agent-account-failover-monitor.ts`, `agent/account-failover-migration.ts` and `persisted-config.ts`. Do not edit the migration code. A stalled `running` agent on a capped account is handed to failover by cancelling its turn with a limit-shaped `lastError` (workstream S), not by moving it directly.
- The restart-recovery (`w1-2-restart-recovery`) and conditional-heartbeat (`w1-3-conditional-heartbeats`) branches cover agents cut off by a daemon stop and scheduled wakes. The stalled-agent sweep covers only an agent stuck in `running` on a live daemon.
- User-facing agent notifications stay as they are: agent finished, permission requests, finish reports.
- `~/bozeo-ops/work-audit.mjs` is the prototype for inventory and snapshots. Port its approach; leave the file where it is.
