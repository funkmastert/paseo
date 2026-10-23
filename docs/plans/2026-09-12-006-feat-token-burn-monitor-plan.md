# Daemon-side token-burn monitor with notifications

Status: design complete, building immediately (user-approved skip of review gate).
Provenance: design agent (Sonnet 5) on 2026-09-12; verified against the tree at `aea8b5ea2`. Full design retained in the orchestrator transcript; this doc records the decisions and implementation map.

## User ask

"Add an agent monitor to make sure no single agent is burning too many tokens and send a notification if so."

## Nature

Daemon-side, absolute, configured threshold monitor — the safety net when no UI is open. Distinct from the client-side relative badge (plan 005). Reuses the token-rate ring (`token-rate-tracker.ts`, `ManagedAgent.tokenRateBuckets/totalTokens`) and the push-notification pipeline; runs on its own unref'd 60s timer like the subagent sweep.

## Key decisions

- **Placement**: daemon core — new standalone `AgentTokenBurnMonitor` class beside `AgentTitleTracker` (needs in-process access to rate buckets, push sender, config store; plugin has no push surface).
- **Triggers, both configurable**: (a) sustained rate — `>= ratePerMinute` on `>= sustainedMinutes` CONSECUTIVE sweeps (one big cache-read turn reads high for the whole 5-min ring; consecutive-sweep counting filters that class); (b) cumulative `totalTokens`, ratcheted to the next multiple after each fire. Defaults: 50K tok/min, 3 min, 5M total, enabled by default (`=== false` opt-out idiom).
- **Protocol — do NOT extend `attentionReason`**: every wire surface for it is a closed non-catching `z.enum(["finished","error","permission"])` (messages.ts:900/:923/:829-843/:4629-4643, agent-storage.ts:73); adding a value breaks `agent_state`/`agent_list` parsing on every shipped client (client-capabilities.ts documents this exact failure mode for customModeIcons/terminalReflowableSnapshot). Instead: additive-optional `tokenBurnAlert? {trigger, ratePerMinute?, totalTokens?, firstBreachedAt}` on both agent payload schemas (the recentTokenRate precedent), plus push payloads (untyped JSON, safe for new `reason: "token_burn_rate"|"token_burn_total"|"token_burn_multi"` values; old apps fall back to opening by agentId).
- **Scope**: all non-internal agents INCLUDING delegated children (config `scope: "all"|"topLevelOnly"`, default all) — deliberately diverging from `broadcastAgentAttention`'s child-exclusion; a runaway subagent is exactly the target.
- **Episodes**: fire once per breach; rate re-arms after a below-threshold sweep run of the same length; total re-arms only at the next threshold multiple. OMP/Pi/idle agents (`computeTokenRate === undefined`) never breach the rate leg; the total leg still applies.
- **Storms**: > `breachBatchThreshold` (default 3) breaches in one sweep → one combined push; badges still set per-agent.

## Implementation map

- `persisted-config.ts`: `agents.tokenBurnMonitor` strict-optional schema {enabled, ratePerMinute, sustainedMinutes, totalTokens, scope, breachBatchThreshold}.
- `messages.ts`: `MutableTokenBurnMonitorConfigSchema` (+Patch, passthrough, defaults) folded into `MutableDaemonConfigSchema`/`PatchSchema`; `daemon-config-store.ts` pick/merge treatment mirroring `pickMetadataGenerationPatch` (live-toggle like 553af7e5e); `tokenBurnAlert` additive-optional on `AgentSnapshotPayloadSchema` + `AgentListItemPayloadSchema`.
- New pure `packages/server/src/server/agent/token-burn-detector.ts`: `evaluateTokenBurn({tokenRate, totalTokens, config, previousState, nowMs}) → {trigger: "rate"|"total"|null, nextState}` encapsulating consecutive counting, ratchet, re-arms.
- `agent-manager.ts`: live-only `tokenBurnAlert?`/`tokenBurnMonitorState?` on ManagedAgent (cleared on rewind at the existing site); `listAgentsForTokenBurnMonitor()` narrow accessor {id,title,workspaceId,internal,isDelegated,tokenRate,totalTokens}; `setTokenBurnAlert`/`clearTokenBurnAlert` → emitState.
- New `packages/server/src/server/agent-token-burn-monitor.ts`: start/stop (setInterval+unref, double-start guard), tick = fresh config read → early-outs → per-agent evaluate → batch decision → push via `pushNotificationSender` + badge set/clear. Wired in bootstrap.ts beside AgentTitleTracker; stopped in daemon stop().
- `agent-projections.ts`: project `tokenBurnAlert` in both payload projections; never stored.
- `packages/protocol/src/agent-attention-notification.ts` (or sibling): `buildTokenBurnNotificationPayload` + batched variant (title/body with rate/total + agent title; data {serverId, workspaceId, agentId(s), reason}).
- `packages/protocol/src/agent-state-bucket.ts`: `tokenBurnAlert` presence is attention-worthy in bucket derivation (+ thread the field at app call sites).

## Tests

Pure detector (below-threshold, consecutive-requirement, spike-class immunity, ratchet, both re-arm rules, undefined-rate safety); agent-manager (accessor filtering incl. scope, alert set/clear emit + projection round-trip, rewind clears); monitor class (disabled/no-agents early-outs, single breach = one push + badge, batch path, re-arm clears); projections (present/absent/never-stored); wire-compat legacy-schema replica parses payloads carrying tokenBurnAlert; config-store live-toggle round-trip; agent-state-bucket derivation.

## Phasing

1. Everything above (badge + push). 2. App rendering polish of rate/total in rows/detail. 3. (deferred) capability-gated in-app toast message (`CLIENT_CAPS.tokenBurnAlerts`, providerSubagents precedent).
