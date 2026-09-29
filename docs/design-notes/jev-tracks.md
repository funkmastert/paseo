# JEV build: tracks, ownership, and what exists today

The build plan for [docs/jev.md](../jev.md). Seven tracks build it: foundation, then six feature tracks in parallel that do not talk to each other. Every line reference is to commit `09a1c045f` on `multi-account-orchestrator`; after the foundation merges, find a region by the function named beside it, not by the number.

## Tracks

| Track       | Features                                                       | Starts after      | Branch (suggested)                           |
| ----------- | -------------------------------------------------------------- | ----------------- | -------------------------------------------- |
| foundation  | the client, config, ledger, audit, fake, RPCs, protocol fields | this doc merges   | `multi-account-orchestrator-jev-foundation`  |
| classifier  | 2                                                              | foundation merges | `multi-account-orchestrator-jev-classifier`  |
| remediation | 3a, 3b                                                         | foundation merges | `multi-account-orchestrator-jev-remediation` |
| tools       | 4, 5, 6                                                        | foundation merges | `multi-account-orchestrator-jev-tools`       |
| compaction  | 9                                                              | foundation merges | `multi-account-orchestrator-jev-compaction`  |
| stalls      | 10                                                             | foundation merges | `multi-account-orchestrator-jev-stalls`      |
| ui          | 11                                                             | foundation merges | `multi-account-orchestrator-jev-ui`          |

## File ownership

Every file any track creates or edits has one owner. A track that needs a change in a file it does not own asks the orchestrator; it does not make the change. Test files belong to the owner of the file they test.

### foundation

| File                                                                                         | Change                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/server/src/server/jev/contract.ts`                                                 | Exists as the interface stub; foundation owns it from here                                                                                                                                                                                                                                                                     |
| `packages/server/src/server/jev/{wire,transport,fake,config,redact,ledger,audit,service}.ts` | New                                                                                                                                                                                                                                                                                                                            |
| `packages/server/src/server/jev/jev.e2e.test.ts`                                             | New: `createPaseoDaemon` with the fake, `jev.status` and `jev.decide` over the wire                                                                                                                                                                                                                                            |
| `packages/server/src/server/session/jev/jev-session.ts`                                      | New: the two RPC handlers, after `session/context-usage/context-usage-session.ts`                                                                                                                                                                                                                                              |
| `packages/protocol/src/jev/rpc-schemas.ts`                                                   | New: request and response schemas for both RPCs                                                                                                                                                                                                                                                                                |
| `packages/protocol/src/messages.ts`                                                          | Register the RPC schemas in the inbound and outbound unions (beside the context-usage entries at `:85-87`, `:3826`, `:7516`); add the `jev_decision` item to `AgentTimelineItemPayloadSchema` (`:1283-1335`); add `features.jev` and `features.jevDecisionItems` (`:4114-4295`); add the hello capability entry beside `:8048` |
| `packages/protocol/src/agent-types.ts`                                                       | `JevDecisionTimelineItem` in the `AgentTimelineItem` union (`:447-460`)                                                                                                                                                                                                                                                        |
| `packages/protocol/src/client-capabilities.ts`                                               | `jevDecisionItems: "jev_decision_items"` with a `COMPAT(jevDecisionItems)` tag                                                                                                                                                                                                                                                 |
| `packages/protocol/src/agent-labels.ts`                                                      | `JEV_TOOLS_LABEL = "paseo.jev-tools"`, `JEV_CALL_LABEL = "paseo.jev-call"`, `TASK_CLASS_SOURCE_LABEL = "paseo.task-class-source"`                                                                                                                                                                                              |
| generated protocol validators                                                                | Whatever `npm run generate:validators --workspace=@getpaseo/protocol` rewrites                                                                                                                                                                                                                                                 |
| `packages/client/src/daemon-client.ts`                                                       | `jevDecide`, `jevStatus`                                                                                                                                                                                                                                                                                                       |
| `packages/client/src/index.ts`                                                               | `PaseoApi.jev` (`:483-491`) and `createPaseoApi`                                                                                                                                                                                                                                                                               |
| `packages/server/src/server/authorization/operation-permissions.ts`                          | `jev.decide.*` → `workspace.write`, `jev.status.*` → `daemon.read`                                                                                                                                                                                                                                                             |
| `packages/server/src/server/persisted-config.ts`                                             | `AgentJevSchema`, strict, with every feature's keys; `agents.jev` in the `agents` object (`:818-843`)                                                                                                                                                                                                                          |
| `packages/server/src/server/daemon-config-store.ts`                                          | `"agents.jev"` in `RELOADABLE_PATHS` (`:193-239`), beside `agents.tokenAudit`, with no mutable mapping                                                                                                                                                                                                                         |
| `packages/website/public/schemas/paseo.config.v1.json`                                       | Regenerated by `npm run generate:config-schema --workspace=@getpaseo/server`                                                                                                                                                                                                                                                   |
| `packages/server/src/server/session.ts`                                                      | **Region: dispatch.** A `dispatchJevMessage` beside `dispatchUsageMessage` (`:2224-2238`) and the session's constructor option                                                                                                                                                                                                 |
| `packages/server/src/server/websocket-server.ts`                                             | **Region: construction and features.** The `jev` constructor option passed to sessions; `features.jev: true` after `agentContextUsage: true` (`:1731`)                                                                                                                                                                         |
| `packages/server/src/server/bootstrap.ts`                                                    | **Region: jev service.** Create the service once, after `DaemonConfigStore` (`:1249-1265`); pass it to the WebSocket server options (`:2606-2650`); flush the ledger at shutdown (`:3068-3072`); add `jevOverrides.transport` to the daemon config type for tests                                                              |
| `packages/app/**`                                                                            | Only if adding the timeline item breaks an exhaustive switch at typecheck: a `case "jev_decision": return null;` placeholder. The ui track owns those lines afterwards.                                                                                                                                                        |
| `docs/jev.md`                                                                                | The "Client" section and "Testing"                                                                                                                                                                                                                                                                                             |

### classifier

| File                                                                                          | Change                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/claude-account-pool/server/jev-hint.ts`                                              | New: questions, state, `fetchSpawnHint`, the pure mapping from answers to a hint                                                                                                                                                         |
| `plugins/claude-account-pool/server/jev-availability.ts`                                      | New: polls `paseo.jev.status()` every 60 s, for the `paseo.jev-tools` decision                                                                                                                                                           |
| `plugins/claude-account-pool/index.server.ts`                                                 | Role hook (`:322-339`): await the hint before `roleRouter`; create and stop the availability poller in `ensureStarted` (`:93-235`) and cleanup (`:493-511`)                                                                              |
| `plugins/claude-account-pool/server/role-router.ts`                                           | Pass the hint and availability into `classifyAgent` (`:630-650`); write `paseo.task-class-source`, `paseo.jev-call`, `paseo.jev-tools`                                                                                                   |
| `plugins/claude-account-pool/server/classifier.ts`                                            | `ClassifierInput.jevHint`, `ClassifierWorldBase.jevToolsAvailable`, `RoleSource` `"classified-jev"`, `AgentDecision.jevTools`; rewrite the header's "no LLM" paragraph (`:68-75`) to say what changed and why the function is still pure |
| `plugins/claude-account-pool/server/role-resolve.ts`                                          | The JEV tiers in `resolveRole` (`:153-177`) and `resolveTaskClass` (`:241-253`); `TaskClassSource` `"jev"`                                                                                                                               |
| `plugins/claude-account-pool/server/decision-log.ts`                                          | The `jev` field on the line                                                                                                                                                                                                              |
| `plugins/claude-account-pool/server/decision-summary.ts`                                      | Name the JEV source in the summary                                                                                                                                                                                                       |
| `plugins/claude-account-pool/server/role-policy-rpc-handlers.ts`, `server/classifier-tool.ts` | "Decided at create" for a value JEV would supply                                                                                                                                                                                         |
| `plugins/claude-account-pool/shared/role-policy-schema.ts`                                    | The three label constants, spelled as in `agent-labels.ts`                                                                                                                                                                               |
| `plugins/claude-account-pool/README.md`                                                       | A section on the spawn hint                                                                                                                                                                                                              |
| `docs/jev.md`                                                                                 | "Feature 2" only                                                                                                                                                                                                                         |

### remediation

| File                                                     | Change                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/remediation/jev-triage.ts`   | New: questions, state, decision function, async triage                                                                             |
| `packages/server/src/server/remediation/ladder.ts`       | `triageEscalation` dependency (`:58-65`); the deferral check in `evaluate` (`:280-283`); the call in `startAgent` after `:338-342` |
| `packages/server/src/server/remediation/ladder-state.ts` | Optional `jevTriage` and `jevDeferredUntil` on `EpisodeSchema` (`:44-59`)                                                          |
| `packages/server/src/server/attention-push-triage.ts`    | New: finish-triage question, state, `finishedPushLevel`                                                                            |
| `packages/server/src/server/websocket-server.ts`         | **Region: attention push.** `broadcastAgentAttention` (`:2620-2704`) only                                                          |
| `packages/server/src/server/bootstrap.ts`                | **Region: ladder factory** (`:864-935`) only                                                                                       |
| `docs/remediation.md`                                    | "The rungs", "The remediation agent", "State and restarts". Not the Conditions table.                                              |
| `docs/notification-policy.md`                            | A sentence under Levels and the finish row in the sender inventory                                                                 |
| `docs/jev.md`                                            | "Feature 3a" and "Feature 3b" only                                                                                                 |

### tools

| File                                                       | Change                                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/agent/tools/jev-tools.ts`      | New: `registerJevTools` and the seven tools                                                                                                                          |
| `packages/server/src/server/agent/tools/jev-file-state.ts` | New: resolving, expanding, pruning and reading files                                                                                                                 |
| `packages/server/src/server/agent/tools/jev-command.ts`    | New: running `ask_jev`'s command behind the `CommandGate`                                                                                                            |
| `packages/server/src/server/agent/tools/jev-diff-risk.ts`  | New: `ask_jev_diff_risk`                                                                                                                                             |
| `packages/server/src/server/agent/tools/paseo-tools.ts`    | `jevTools` in `PaseoToolHostDependencies` (`:112-166`); the registration beside the device lease tools (`:1244-1253`)                                                |
| `packages/server/src/server/bootstrap.ts`                  | **Region: tool host dependencies** (`createAgentToolHostDependencies`, `:2300-2340`) only, including the adapter from the catastrophe gate's export to `CommandGate` |
| `docs/jev.md`                                              | "Features 4–6" only                                                                                                                                                  |

### compaction

| File                                                            | Change                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/agent/leader-compaction-timing.ts`  | New: the advisor, its questions, state and verdicts                                                                    |
| `packages/server/src/server/agent/leader-compaction-planner.ts` | The optional `timing` input to `planLeaderCompactionStep` (`:165-220`)                                                 |
| `packages/server/src/server/agent-leader-compaction-monitor.ts` | The advisor option; pass verdicts in `sweep` (`:251-286`); the cut-point sentence in `formatCompactCommand` (`:85-91`) |
| `packages/server/src/server/bootstrap.ts`                       | **Regions:** the `handleAgentTurnFinished` assignment (`:1968`) and the monitor construction (`:2880-2892`) only       |
| `docs/leader-compaction.md`                                     | A section on JEV timing and the config it reads                                                                        |
| `docs/jev.md`                                                   | "Feature 9" only                                                                                                       |

### stalls

| File                                                 | Change                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/agent/stall-judgment.ts` | New: question, state, decision function, loop prefilter                                                                                                                                                                                                                                                       |
| `packages/server/src/server/agent-stall-sweep.ts`    | `readRecentActivity` and `judgeStall` dependencies (`:60-70`); the judgment in `handleCandidate` (`:320-348`); prompt lines in `act` (`:436-443`) and `buildStallNudgePrompt` (`:606-618`); no `escalation` in `buildStallObservation` (`:624-677`) for the two cases; the loop watch in `sweep` (`:192-247`) |
| `packages/server/src/server/remediation/contract.ts` | `"looping-agent"` in `RemediationConditionKind` (`:14-24`)                                                                                                                                                                                                                                                    |
| `packages/server/src/server/bootstrap.ts`            | **Region: stall sweep factory** (`:1023-1071`) only                                                                                                                                                                                                                                                           |
| `docs/stalled-agents.md`                             | A section on the judgment and the loop watch                                                                                                                                                                                                                                                                  |
| `docs/remediation.md`                                | **One row** at the end of the Conditions table, for `looping-agent`                                                                                                                                                                                                                                           |
| `docs/jev.md`                                        | "Feature 10" only                                                                                                                                                                                                                                                                                             |

### ui

| File                                                                   | Change                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/server/jev/decision-timeline.ts`                  | New: the `JevDecisionSink` that appends `jev_decision` rows, and the `paseo.jev-call` attachment on agent creation                                        |
| `packages/server/src/services/quota-fetcher/providers/jev.ts`          | New: the budget-strip fetcher                                                                                                                             |
| `packages/server/src/services/quota-fetcher/manifest.ts`               | The `jev` entry (`:17-68`) and its create option                                                                                                          |
| `packages/server/src/server/agent/agent-manager.ts`                    | `appendDaemonNoteItem`, which records without `touchUpdatedAt` (`:3795-3818` is the model); `lastActivityAtOf` ignores `jev_decision` rows (`:1892-1902`) |
| `packages/server/src/server/agent/agent-timeline-store.ts`             | Only if `getLastRowTimestamp` needs a type filter for the above                                                                                           |
| `packages/server/src/server/session.ts`                                | **Region: timeline gating.** `supportsTimelineItem` (`:1318-1327`) and the `notification` downgrade where items are forwarded                             |
| `packages/server/src/server/websocket-server.ts`                       | **Regions:** the `ProviderUsageService` construction (`:779-790`) and `jevDecisionItems: true` after `pluginTimelineItems: true` (`:1770`)                |
| `packages/server/src/server/bootstrap.ts`                              | **Region: after AgentManager construction** (`:1711-1725`): attach the timeline sink                                                                      |
| `packages/client/src/connection/index.ts`                              | Advertise `CLIENT_CAPS.jevDecisionItems` in the defaults (`:17` is the pattern)                                                                           |
| `packages/app/src/agent-stream/jev-decision-row.tsx`                   | New: the row                                                                                                                                              |
| `packages/app/src/agent-stream/view.tsx`                               | The `jev_decision` case (`:864-902`)                                                                                                                      |
| `packages/app/src/types/stream.ts`                                     | Mapping beside the `plugin` cases (`:1579`, `:1737`)                                                                                                      |
| `packages/app/src/orchestration/account-budget-strip-model.ts`         | `PROVIDER_VENDORS` gains `jev: "TypeSafe"` (`:247`)                                                                                                       |
| `packages/app/src/orchestration/account-budget-strip.browser.test.tsx` | A `jev` row in the fixture                                                                                                                                |
| `docs/orchestration-panel.md`                                          | The budget strip section: the JEV row                                                                                                                     |
| `docs/jev.md`                                                          | "Feature 11" only                                                                                                                                         |

### Shared files

| File                  | Regions and owners                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap.ts`        | foundation: jev service creation, WebSocket server option, shutdown, daemon config type. remediation: ladder factory. stalls: stall sweep factory. ui: after AgentManager construction. compaction: `handleAgentTurnFinished` and the monitor construction. tools: tool host dependencies. |
| `websocket-server.ts` | foundation: construction and `features.jev`. remediation: `broadcastAgentAttention`. ui: `ProviderUsageService` and `features.jevDecisionItems`.                                                                                                                                           |
| `session.ts`          | foundation: dispatch. ui: timeline gating.                                                                                                                                                                                                                                                 |
| `docs/remediation.md` | remediation: rung sections. stalls: one Conditions row.                                                                                                                                                                                                                                    |
| `docs/jev.md`         | Each track its own section.                                                                                                                                                                                                                                                                |

The regions are far enough apart that git merges them without conflict. A track that finds it needs a line outside its region stops and asks.

Every config key and every protocol field any feature needs is created by the foundation. No feature track edits `persisted-config.ts`, `daemon-config-store.ts`, `packages/protocol/**` or `packages/client/src/{daemon-client,index}.ts`.

## Dependency graph and merge order

```text
design ──► foundation ──┬──► classifier (2)
                        ├──► remediation (3a, 3b)
                        ├──► stalls (10)
                        ├──► compaction (9)
                        ├──► tools (4–6) ◄ · · catastrophe-gate (feature 1), by interface only
                        └──► ui (11)
```

- No feature track depends on another. Each records decisions through `jev.decisions`, which is ledger-only until ui replaces the sink, so rows appear for every merged feature the moment ui lands, in any order.
- **tools and the catastrophe gate.** tools codes against `CommandGate` in `jev/contract.ts`. If the gate has merged, tools adapts its export in bootstrap. If not, tools merges with `command` refused ("command needs the catastrophe gate; run it with Bash"), and whichever of the two merges second adds the adapter, about ten lines in the tool host dependency region. There is never a window where `ask_jev` runs a command without the gate.

Merge order after the foundation: classifier, remediation, stalls, compaction, tools, ui.

- classifier touches only plugin files, so it cannot conflict.
- remediation and stalls both touch `docs/remediation.md`, in different hunks; stalls rebases on remediation.
- tools goes after the catastrophe gate when it can.
- ui goes last: it touches the hottest files (`agent-manager.ts`, `session.ts`) and its end-to-end check wants real rows from the others.

Each track rebases on the integration branch before its adversarial review and again before merge. Run at most four at once while the machine is loaded.

## Done, for every track

- The track's verification command from its section of `docs/jev.md`, green.
- `npm run typecheck` for the touched workspaces, and `npm run lint -- <files>`, `npm run format:files -- <files>`, through `~/bozeo-ops/cpu-policing/heavy.sh` while load is high.
- Its section of `docs/jev.md` corrected to what was built; its subsystem doc updated per the table.
- No live JEV call anywhere, including manual runs. The fake, or `PASEO_JEV_BACKEND=fake` on a scratch daemon, never port 6767.
- Fail-open tests: every non-`answered` outcome gives today's behaviour, asserted against the same fixture as the answered case.

## What exists today

Verified by reading the code at `09a1c045f`. Build on these; do not design around anything not listed.

### For everyone

- **Config read live from `config.json`**, no mutable mapping: `agents.tokenAudit` (`token-audit/config.ts:1-5`; `RELOADABLE_PATHS` entry with the reason at `daemon-config-store.ts:226-229`) and `agents.providerUsage.openaiApi` (`persisted-config.ts:634-652`; read per fetch at `websocket-server.ts:782-789`).
- **Strict config.** `PersistedConfigSchema` is `.strict()` (`persisted-config.ts:855`); every section is; an unknown key stops the daemon (`:972-978`).
- **Key handling precedent.** `openai-api.ts`: env first, then an env file, never stored, logged or put in an error (`:141-142`, `resolveKey` `:249-259`, `parseEnvFileValue` exported at `:82`). Logger redaction covers only `authorization` header paths (`logger.ts:49-62`).
- **HTTP precedent.** `fetchProviderApi` with `AbortSignal.timeout` (`services/quota-fetcher/usage.ts:10-31`).
- **RPC precedent.** `agent.context_usage.read`: schema `protocol/src/context-usage/rpc-schemas.ts:55-75`, registered at `messages.ts:85-87,3826,7516`, dispatched at `session.ts:2229-2233`, handled in `session/context-usage/context-usage-session.ts`, permission at `operation-permissions.ts:15,227`, client at `daemon-client.ts:5207`.
- **`server_info.features`** schema `messages.ts:4114-4295`, set at `websocket-server.ts:1708`.
- **Atomic JSON writes:** `writeJsonFileAtomic`, as the ladder uses (`ladder-state.ts:96-98`).
- **Timeline reads:** `AgentManager.fetchTimeline(id, { direction: "tail", limit })` (`agent-manager.ts:2356-2359`), `getLastAssistantMessage` (`:4895-4902`).
- **Build.** Server depends on client, highlight, plugin, protocol and relay (`packages/server/package.json:74-78`); `build:server` builds protocol and client first. Protocol's `prebuild` regenerates validators. No tsconfig project references. Rebuild the owning stack before chasing cross-package type errors.

### classifier

- `classifyAgent(input, world)`: synchronous, no I/O (`classifier.ts:1165-1224`; header `:50-97`). `ClassifierInput` `:99-118`; `ClassifierWorldBase` `:124-150`; `RoleSource` `:169-181`; `TaskClassDecision` `:199-206`; `AgentDecision` `:399-409`.
- Tools are withheld for guessed roles: `toolProfileIsEvidenceBased` (`:426-431`); only tiers `undefined`, 1 and 2 are evidence.
- Thinking from the class: `policy.thinking.byTaskClass[taskClass ?? "standard"]` (`:1027`), defaults `mechanical: low, standard: high, hard: xhigh` (`shared/role-policy-schema.ts:208-212`); the leader rule outranks (`:1014-1021`).
- Role tiers and seeds: `resolveRole` (`role-resolve.ts:153-177`), `classify` (`:113-135`), `REVIEWER_SEED_RE` and `ADVISOR_SEED_RE` (`:50-51`). Task class: `resolveTaskClass` (`:241-253`), `HARD_SEED_RE` and `MECHANICAL_SEED_RE` (`:198-201`), `TaskClassSource` (`:179`).
- The role hook is async and awaits cache warm-up and a policy re-read, each capped at 5 s (`index.server.ts:35, 250-301, 322-339`); the router itself is synchronous (`role-router.ts:224-227`), calls `classifyAgent` at `:630-650`, and passes through on any throw (`:512-531`).
- The daemon gives a plugin 30 s for all its `before("agent.create")` handlers together (`packages/server/src/server/plugins/runtime.ts:33, 492-519`); a throw or timeout fails the create (`agent-manager.ts:2410-2416`).
- The plugin runs in a subprocess, bundled by esbuild to CJS and run by indirect eval (`packages/server/src/server/plugins/compiler.ts:386-412`, `plugins/plugin-process.ts:224-227`); it reaches the daemon through `PaseoApi` over IPC (`plugin-process.ts:255-265`).
- The decision log is one `classifier-decision <json>` line per create, written from the account hook (`decision-log.ts:10, 128-142`), into `daemon.log` through the plugin's stdout.
- No label records where a value came from today; there is no `paseo.classified-by`.

### remediation

- `RemediationObservation`, `RemediationSink`, `RemediationConditionKind`: `remediation/contract.ts:14-118`.
- `evaluate` (`ladder.ts:250-302`) and `startAgent` (`:304-380`); the only existing veto between deciding and creating is `findAccountBlocker` (`:338-342`); the create is `deps.createAgent(request)` (`:364`), wired to `createAgentCommand` at `bootstrap.ts:882-898`.
- Rung 3 is `escalate` (`ladder.ts:473-508`), once per episode, level from the observation.
- Episodes persist in `$PASEO_HOME/remediation/state.json` (`ladder-state.ts:44-98`, path at `bootstrap.ts:932`); an unknown kind cannot void the file (`ladder.ts:555-558`).
- The finish push: `checkAndSetAttention` sets `finished` on running→idle for non-delegated agents (`agent-manager.ts:6649-6705`); `broadcastAgentAttention` (`websocket-server.ts:2620-2704`) fetches the final message (`:2644`) and sends at `attentionPushLevel` (`agent-attention-policy.ts:90-95`): `alert` for a root, `notice` for a child. The payload body is the message cut to 220 characters (`protocol/src/agent-attention-notification.ts`).

### tools

- The Paseo tool catalog is built per MCP request with the caller's id (`bootstrap.ts:2382-2410`, `2340-2345`); `registerTool` honours the provider's tool policy (`paseo-tools.ts:591-608`); `resolveCallerAgent` returns the caller's managed agent (`:650-659`).
- Grouped registration precedent: `registerDeviceLeaseTools` (`agent/tools/device-lease-tools.ts:57`), called at `paseo-tools.ts:1244-1253`.
- The `paseo` MCP entry carries `callerAgentId` and a per-run bearer token, and is never persisted (`agent/runtime-mcp-config.ts:7-58`).
- Path helpers: `resolvePathFromBase`, `isSameOrDescendantPath` (`path-utils.ts:22, 30`).
- A plugin cannot mount HTTP routes (`packages/plugin/src/server/contracts.ts:12-24`). The classifier's own tool is a stdio bridge to a Unix socket served by the plugin (`classifier-tool.ts:161-188, 270-273`; injected at `index.server.ts:404-424`).
- The catastrophe gate branch had no `catastrophe-gate.ts` when this was written (`multi-account-orchestrator-catastrophe-gate` at `eb3c754e8`).
- No glob library is a server dependency.

### compaction

- The monitor is a 60-second poll, not an event listener (`agent-leader-compaction-monitor.ts:22, 194-206, 251-286`), and off unless `agents.leaderCompaction.enabled` (`:254`). It is off on the live daemon.
- The planner is pure (`leader-compaction-planner.ts:165-220`); `isOverThreshold` (`:117-122`); `DEFAULT_PREPARE_AT_TOKENS = 400_000` (`:9`).
- Steps start only through `startTurnIfIdle` (`agent-manager.ts:1959-1972`); the context size is `lastUsage.contextWindowUsedTokens` (`:1927-1940`).
- `formatCompactCommand` takes no arguments today (`agent-leader-compaction-monitor.ts:85-91`).
- `onAgentTurnFinished` fires for non-internal, non-quiet running→idle edges (`agent-manager.ts:6607-6614`); its only consumer is the title tracker, through the closure assigned at `bootstrap.ts:1968`.

### stalls

- `notStalledReason` decides a stall from timestamps, usage, permissions and CPU, never the timeline's content (`agent/stall-detector.ts:40-68`).
- The sweep has no timeline access (`agent-stall-sweep.ts:60-70`) and is serialized (`:182-190`); `handleCandidate` (`:320-348`) and `act` (`:384-479`) are where a live nudge happens.
- `lastActivityAtOf` counts the newest timeline row of any type and `updatedAt` (`agent-manager.ts:1892-1902`), so any appended row, plugin rows included, resets the stall clock.
- Config: `resolveStalledAgentSweepConfig` (`remediation/config.ts:80-94`).

### ui

- The only appendable timeline kind is `plugin`, and only from a plugin session (`session.ts:7731-7745`); per-client gating for new kinds is `supportsTimelineItem` (`:1318-1327`), with the `timelineNotifications` and `pluginTimelineItems` COMPAT entries as the pattern (`client-capabilities.ts:35-40`).
- `appendTimelineItem` touches `updatedAt` (`agent-manager.ts:3801`) and persists a snapshot (`:3816`).
- Timeline rows live in daemon memory; provider history is the durable transcript (docs/architecture.md, Agent lifecycle).
- The budget strip builds rows from `listProviderUsage`, and a non-Claude provider with balances appears on its own (`account-budget-strip-model.ts:164-183`); balances are `{ id, label, used, remaining, limit, unit, resetsAt, tone }` (`messages.ts:6836-6845`); the OpenAI API row is the precedent (`manifest.ts:59-67`).

## Risks and disagreements

Decisions #1–#10 in `~/bozeo-ops/jev-build-STATE.md` are designed to as written. These points are raised for Tyler or the orchestrator and were not changed silently.

1. **Decision 7, "a JEV guess may add but never remove capability."** This design reads capability as tools, as `classifier.ts:82-90` does, so JEV may lower a task class and put an agent on a cheaper model. If model tier counts as capability, the spawn hint may only raise a class, and the Haiku cost lever this feature was chosen for goes away. Needs Tyler's reading.
2. **Feature 2 reverses a settled classifier choice.** The classifier's header records that an LLM on every create "was evaluated and rejected on arithmetic" (`classifier.ts:72-75`). JEV costs about $0.0001 and 0.3 s per unlabelled create, not every create, and the function stays pure because the answer arrives as an input. Still a reversal: the classifier track rewrites that paragraph rather than leaving it contradicted.
3. **"JEV infers … a thinking level."** In this fork thinking follows the task class through `policy.thinking.byTaskClass`. A separate JEV thinking level would be a second decider next to the policy, against decision 7. The design lets the reasoning score inform the class and leaves thinking to the policy.
4. **The preview and the hook can disagree.** `role-model-policy.explain` and the `agent_model_policy` tool must not spend, and JEV repeats differ 5–13% of the time, so for an unlabelled create the preview says "decided at create". The classifier's rule that the preview and the hook cannot disagree now has that one exception.
5. **The OpenRouter endpoint is unverified.** The reference calls `https://openrouter.ai/api/alpha/decisions`; TypeSafe's SDK docs imply `https://openrouter.ai/api/v1/systemone`. An `alpha` path can move. Configurable; check both on the first live call.
6. **The reference's file limit is too large.** It allows about 240 KB per file against a 32K-token limit for state plus question. This design caps state at 60 KB. JEV's tokenizer is unknown; the ledger's `stateBytes` against `input_tokens` will say where the cap belongs.
7. **Company code leaves the machine.** Features 4–6, 9 and 10 send whatever the agent is working on. Agents in the Wonderly mobile worktrees would send Wonderly's code and conversations to TypeSafe under its perpetual telemetry licence, and OpenRouter's own retention for this traffic is unknown. Decision 9 accepted the privacy terms, but that is a question about Tyler's employer's code, not his own. Recommended, not built: an `agents.jev.excludeCwds` list (default the Wonderly paths) under which features 4–6, 9 and 10 do not call. Needs Tyler.
8. **The key's variable name is generic.** `OPENROUTER_API_KEY` is what the reference and the install track use. If Tyler sets it for another tool, every JEV feature turns on live, including the ones that send code. Alternatives: a dedicated variable, or `agents.jev.enabled` defaulting to `false`. Needs Tyler.
9. **The floors are uncalibrated.** TypeSafe publishes no calibration; independent expected calibration error is 0.13–0.25; "does anything apply" questions scored 0.52 in one paper; answers change on 5–13% of repeats. The floors here are starting points. Recommended: run the first day with a key in `shadow` for every feature and move floors only on the audit's evidence.
10. **The agent tools may not pay.** Research 03 recommended against an `ask_file` tool: each use costs a model step of about 25K weighted tokens at median context, the same size as the read it saves. Tyler chose to build them. The ledger counts JEV calls, but whether they save agent tokens needs the token audit to compare agents with and without the label.
11. **Feature 9 is inert today.** `agents.leaderCompaction.enabled` is off on the live daemon, and the timing advisor only feeds that monitor.
12. **The catastrophe gate's interface is not known yet.** Its branch had no code at `eb3c754e8`. tools codes against `CommandGate` and refuses `command` until the adapter exists, so a mismatch costs a bootstrap line, never a bypass.
13. **`jev.decide` is open to any `workspace.write` client**, a paired phone included. That client can already spawn agents costing far more; the daily cap bounds JEV spend.
14. **Timeline rows are lost on restart**, like plugin rows. The ledger's daily totals and the audit survive.
15. **Unrelated, found while reading:** the classifier tool's stdio MCP entry is not stripped before the agent's config is stored (`agent-manager.ts:7053`, `runtime-mcp-config.ts:7-28`), so a resume after a plugin reload may point at a deleted bridge. Not verified at runtime. The JEV tools avoid the pattern.
