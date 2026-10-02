# Leaders settle back to the leader account; messages follow a moved session

Brief: `~/bozeo-ops/briefs/open/leader-settle-back.md`. Branch `multi-account-orchestrator-leader-settle-back`.

## Why

Tyler, 2026-10-01: "my budget for 2 accounts was out but i still had my leader account and you never got switched to it... fix that."

- The orchestrator's root session `e8e58ad7` was imported off the leader account (`claude`) onto a worker as `423edc86` (`claude-backup`). Nothing moves a root back: commit 3b94ecd9c (09-24) removed the return leg Tyler asked for on 09-22 ("leaders ride the backup account until refresh, then settle back"). The `return*` config keys are accepted and ignored.
- Later the conversation was revived on `claude` as `e8e58ad7`, but Tyler's messages went to the retired `423edc86` (it carries `paseo.account-failover.migrated-to`) on the capped `claude-backup` and failed with "You've hit your weekly limit". Failover skips retired handles, so nothing rescued them.

## Seam (done, 3b3d6f33d)

`@getpaseo/protocol/agent-labels` now owns `ACCOUNT_FAILOVER_MIGRATED_TO_LABEL`, `getMigratedToFromLabels` and `followMigratedTo(agentId, labelsOf)` → `{kind:"self"} | {kind:"moved", agentId, chain} | {kind:"loop", chain}`. `labelsOf` returns null for an agent that does not exist; the walk stops at the last one that does. The server detector re-exports the label helpers. Units 2 and 3 code against this; nobody re-implements the walk.

## Unit 1: settle-back for roots (server)

New pure planner `packages/server/src/server/agent/account-failover-settle-back.ts` (+ test), called from `AgentAccountFailoverMonitor.sweep` after the idle rehomes, plus the move in `account-failover-migration.ts`.

A **root** (no `paseo.parent-agent-id`), not internal, on a pool entry whose role is `worker`, settles back to the leader account when all of these hold:

- **Idle between turns:** `lifecycle === "idle"`, not `busy`, no pending permission, has a session, no `migrated-to`, no limit-shaped `lastError` (that is the rescue leg's), not claimed by restart recovery, not in a refusal backoff. Quiet for at least `SETTLE_BACK_MIN_IDLE_MS` (2 minutes, from `lastActivityAt`) so a move never lands between two messages of a live exchange. Re-read the agent right before moving; skip it if a turn started.
- **The leader has real headroom:** an enabled `leader` pool entry that is not in this sweep's dead set, is not the same Claude login as the source (`providersShareAccount`), and whose usage is askable: a usage row for it exists, is not `unavailable`, has windows, and was fetched within 10 minutes. Every weekly window that limits the agent's model (`weekly`, and `weekly_model_*` for its family via `windowLimitsModel`) is under 90%, and the session window (`five_hour`) is under 80%. Unreadable usage means no settle-back: the burden of proof is the reverse of the rescue's.
- **Once per recovery episode:** an episode for a leader provider starts on the first sweep it passes the headroom gate after a sweep where it did not (or at monitor start). One attempt per agent per episode, success or failure. In memory; a restart costs at most one more attempt. The 5-hour reactive evidence clock already keeps a spend-capped leader dead after a failed settle-back, so this bounds the ping-pong to one round per window.
- **Paced:** sequential, each move through the shared `paceResume` with source `account-failover-settle-back`, so a recovery that frees many roots moves them a few a minute, roots only.

The move: `agentManager.moveAgentToProvider(agent.id, leader)` in place, no prompt. On `session_conflict` from a **retired** holder on the leader (the 10-01 shape: the leader still holds the conversation's old handle), revive that handle the way `migrateStuckAgent` does (`reactivateRevivedHandle` + `retirePredecessor`), no prompt; unit 2 makes messages to the old id follow. Never import a fresh agent. Any other refusal: one-hour backoff, counts as the episode's attempt. Ledger entry at `record` like an idle move.

Config: one new key `agents.accountFailover.settleBack` (boolean, default `true`), live-reloadable, in the server persisted schema (strict), the protocol mutable schema (passthrough), and the monitor's resolved config. The six `return*` keys stay accepted and ignored under `COMPAT(failoverReturn)`; `returnHome: false` does NOT turn settle-back off (an old config must not silently undo what Tyler asked for). Regenerate the validators. Extend `bootstrap.smoke.test.ts`'s reload assertions.

**Unit 1 also owns item 3:** a root's live handle cut off on a capped account goes to the leader account when it has budget, even when a worker has more headroom (`pickTarget` with `preferLeader`). Add the test in `account-failover-migration.test.ts` and the e2e.

**Unit 1 owns `docs/account-failover.md`:** rewrite the "never moves anyone back" paragraph (top) and "Which agents move" with the new rule and its reason: Tyler's explicit choice (09-22, reaffirmed 10-01), the cost (one cache rebuild per settle-back, roots only; children stay put because their rebuilds are the cost the rule exists to avoid), the gates, the episode bound. Update the Configuration table (`settleBack`; the `return*` sentence). Add the message-follows-the-session rule from unit 2 to the Idempotency section where `migrated-to` is described: a prompt to a retired handle is delivered to the end of its `migrated-to` chain, for every entry point; a loop is refused; the app opens the successor with a one-line "moved to <account>" note. Integrate, don't append; repo doc voice.

## Unit 2: messages follow the session (server, client, CLI)

- `sendPromptToAgent` (`agent-prompt.ts`) resolves its target with `followMigratedTo` over stored records (live labels win for loaded agents) before unarchive/load. A loop throws a typed error naming the chain. Return `{ disposition, agentId }` with the id it delivered to; log the redirect. An archived successor is still the live end (the normal `unarchive` flag decides).
- Schedules and heartbeats (`schedule/service.ts` `executeSchedule` calls `startAgentRun` directly, and `schedule/conditions.ts` reads the target): resolve the target first, so a schedule aimed at the old id fires on the successor and its conditions read the successor. Record the delivered id on the run.
- App send and CLI send (`session.ts` `send_agent_message_request` / `send_agent_message`): deliver to the successor. Add optional `deliveredToAgentId` to `SendAgentMessageResponseMessageSchema` (only set on a redirect; `agentId` keeps today's meaning). Regenerate validators; build the client. The CLI `send` prints "delivered to <id> (moved)" and its `--wait`/follow-up wait targets the delivered id.
- MCP `send_agent_prompt` (`tools/paseo-tools.ts`) and `coordination-tools.ts`: the tool result names the delivered id and that it was redirected; any wait inside the tool waits on the successor.
- Finish reports: `finish-obligation-service.ts` `resolveOwner` uses `followMigratedTo` (keep its archived-successor stop, which is right for system reports) and refuses a loop instead of delivering to an arbitrary hop. `setupFinishNotification` goes through `sendPromptToAgent` and follows for free; test it.
- Tests first for each entry point: agent-prompt, schedule service, session send, MCP tool, finish-obligation, CLI send if it has tests. Do not edit `docs/account-failover.md` (unit 1 owns it); `docs/finish-reports.md#successors` may need a line.

## Unit 3: the app opens the successor

When the agent the app is showing (agent route, workspace tab, pinned-grid cell; desktop, web and phone) carries `migrated-to`, follow it with `followMigratedTo` over the agents the app holds for that host and show the live end instead, with a one-line note "Moved to <account label>" (the successor's provider display name). The note is dismissible or fades; it does not block. A loop or an unknown successor leaves the handle in place with a note saying where it was moved if known. Read `docs/expo-router.md` before touching routes or selection, `docs/design.md`, `docs/unistyles.md`. Tests for the selection/redirect logic; Playwright or browser proof for web/desktop if the repo's tests support it. No daemon change; works against any daemon, so no feature gate.

## Gate (orchestrator, after merging the units)

Per `~/bozeo-ops/briefs/jev-track-common.md`: foreground, no `--bail`, file lists built with `find` and counted. `npm run build:client`; typecheck protocol, client, server, app, plugin; every `account-failover*`, `account-pool*`, `agent-prompt*`, `finish-report*`/`finish-obligation*` test, `agent-account-failover-monitor.e2e.test.ts`, `persisted-config`, `bootstrap.smoke`, the client suite, the schedule tests, and the app tests touched. Lint and format on touched files. Never the live daemon on 6767.
