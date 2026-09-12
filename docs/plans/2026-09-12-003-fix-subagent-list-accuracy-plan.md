# Subagent list accuracy: reconnect repair + reconciliation sweeps

Status: investigation complete (evidence verified live), fix design ready for implementation.
Provenance: read-only investigation agent (Sonnet 5) on 2026-09-11; verified against the tree at `e0542f843` and the live daemon (0.8.0, pid 61202).

## User complaint

"The sub agent list is not accurate.. we need a dedicated daemon or something to make sure they are always up to date." Recurrence of the pre-fork complaint ("often the sub agents get hidden or not cleaned up"). Reporting client context: stock mobile app + self-hosted fork web app, both via relay.

## Verified root causes (ranked)

1. **Provider-subagent view has no reconnect path — primary cause.** `useSubagentsForParent` (`packages/app/src/subagents/select.ts:162-167`) refreshes via a `useEffect` keyed on `[client, parentAgentId, serverId, supported]`, but `DaemonClient` reconnects internally reusing the same instance (`packages/client/src/daemon-client.ts:6151-6163`) — object identity never changes, so the effect never refires. Events missed while disconnected are lost until the component remounts. Contrast: `DirectorySync.connectionChanged` (`packages/app/src/runtime/directory-sync/index.ts:177-263`) keys on `connection.source.{clientGeneration,connectionEpoch}` — `connectionEpoch` increments on every online transition (`host-runtime.ts:1082-1084`) — which is why the agent/workspace directory self-heals and this store doesn't. Relay clients reconnect constantly (network changes, backgrounding), so they hit this hardest — matching where it was reported.
2. **No liveness sweep for stuck "running" provider subagents.** The only terminalization is `cancelRunningProviderSubagents` (`agent-manager.ts:1702-1714`) from `closeAgentRuntime`. A descriptor whose terminal SDK event never arrives (documented caveats: `docs/agent-lifecycle.md:180,184`) stays "running" forever while its parent sits open. This is the original "hidden or not cleaned up" complaint. Codebase precedent for the fix: `sweepOrphanedSchedules` (`packages/server/src/server/schedule/service.ts:668-688`), currently startup-only.
3. **Orchestration tree is push-only.** The client join (`packages/app/src/orchestration/select.ts:37-101`) is pure and correct; `AgentUpdatesService` + `DirectorySync` resync on connection-epoch changes with cursors. But there's no periodic reconciliation independent of connection-state transitions — a silently dropped frame mid-connection has no backstop. (Also: resync is demand-gated via `hasDemand()`, by design.) `explicit_event_subscriptions` does NOT gate `agent_update`/`agent_archived` (`session.ts:7792-7817`) — not a contributor.
4. **Heartbeat/schedule orphaning — RULED OUT.** Verified on the 02:16Z cascade case study: schedule `c7ace1ca` completed 1ms after its target agent's archive via `setAgentArchivedCallback` → `ScheduleService.completeForAgent` (`bootstrap.ts:1360-1366`, `schedule/service.ts:486-514`, `agent-manager.ts:1790-1833`); cascade archived all three descendants correctly. Don't spend effort here.
5. **CLI `--json` hides `archivedAt`/`labels`** (`packages/cli/src/commands/agent/ls.ts:91-100` projects into the display shape before serializing). Minor observability gap, CLI-only.

## Fix design

The "dedicated daemon" instinct, scoped to what's broken: a client reconnect-repair hook + periodic server-side reconciliation sweeps. **No protocol changes.** Explicitly NOT recommended: server-computed orchestration tree — the join is already correct against fresh inputs; a pushed tree is a bigger, riskier protocol surface solving the wrong layer. Revisit only if fixes 1+2 don't end the reports.

### Fix 1 (app, highest priority): reconnect-aware provider-subagent refresh

- Reuse the generic post-reconnect registry `RECONNECT_REPAIR_POLICIES` / `reconnectSubscriptionRepairsByServerId` (`packages/app/src/data/push-router.ts:104-189`), already used for checkoutDiff/terminals/providers-snapshot/daemon-config.
- Add a `providerSubagents` policy: on reconnect, re-issue `refreshProviderSubagents(client, serverId, parentAgentId)` (`packages/app/src/subagents/provider-store.ts:78-103`) for every `(serverId, parentAgentId)` currently tracked by a mounted `useSubagentsForParent` / `provider-subagent-panel.tsx` — track the active set like `activeCheckoutDiffSubscriptions` does.
- Tests: `push-router.test.ts` repair case; `provider-store.test.ts`/`select.test.ts` case asserting refresh refires on a synthesized reconnect signal (not just `parentAgentId` change).

### Fix 2 (server): periodic reconciliation sweeps

- `schedule/service.ts`: run the existing idempotent `sweepOrphanedSchedules` on an interval (~5 min), not just startup.
- New `sweepStaleProviderSubagents` in `AgentManager` (near `cancelRunningProviderSubagents`): terminalize (`status: "canceled"`) any "running" descriptor whose owning agent is closed/archived (defense-in-depth), and any "running" descriptor with no updates past a liveness threshold (10–15 min, no timeline activity) even while the parent stays open. Use the existing `providerSubagents.apply(...)` + `dispatch({type: "provider_subagent", event})` path — same wire message, zero protocol change.
- Tests: `agent-manager.test.ts` stuck-descriptor sweep; `schedule/service.test.ts` periodic catch of a hypothetically-bypassed archive.

### Fix 3 (CLI, standalone): `--json` includes `archivedAt` and `labels`

- `packages/cli/src/commands/agent/ls.ts` — stop stripping them in JSON output mode.
