# Resource monitor

The daemon tracks OS-level memory and CPU per agent and warns when one runs away, alongside two machine-level checks: swap pressure and orphaned build daemons. It's the process-tree counterpart to [docs/token-burn.md](token-burn.md), which watches provider-reported token usage — same monitor shape, different signal.

## What's attributed, and how

Every 60s, `AgentResourceMonitor` (`packages/server/src/server/agent-resource-monitor.ts`) shells out to `ps -axo pid,ppid,rss,pcpu,etime,command` and, on macOS/Linux, samples system swap. `process-attribution.ts` finds each live agent's root process by the `callerAgentId=<agentId>` marker `withRuntimePaseoMcpServer` (`agent/runtime-mcp-config.ts`) writes into the Paseo MCP URL at launch, then walks `ppid` to collect every descendant. Memory and CPU are summed across the tree.

A process that gets reparented to pid 1 — a crashed shell, a build tool that daemonizes on purpose — falls out of every agent's tree. There's no way to attribute it to whoever launched it, so it isn't folded into any agent's usage. Gradle and Kotlin's compile daemons do this by design, and they're common enough (and heavy enough — idle Gradle daemons commonly hold hundreds of MB to low GB each) to warrant their own signal: any ppid-1 process whose command line matches a known build-daemon marker (`GradleDaemon`, `KotlinCompileDaemon`) is counted separately as an orphan build daemon, by count and total RSS, rather than silently dropped.

## Legs and thresholds

Config lives under `agents.resourceMonitor` (`persisted-config.ts`), live-toggleable like `tokenBurnMonitor`. Four independent sustained-threshold legs (`agent/sustained-breach-detector.ts`), each firing once and re-arming after `sustainedMinutes` (default 3) consecutive sweeps back under threshold:

| Leg                      | Default threshold | Scope                             |
| ------------------------ | ----------------- | --------------------------------- |
| `memoryBytesPerAgent`    | 6 GiB             | per agent's process tree          |
| `cpuPercentPerAgent`     | 400 (four cores)  | per agent's process tree          |
| `systemSwapUsedRatio`    | 0.9               | machine-wide                      |
| `orphanBuildDaemonBytes` | 2 GiB             | machine-wide, orphan daemons only |

An agent's memory and CPU legs are independent state machines but share one alert: the agent's live `resourceAlert` clears only once both legs are back under threshold. A sweep with no attributable process for an agent (it hasn't launched anything, or its tree already exited) is treated as a below-threshold reading — the same path that re-arms a fired leg.

## Actions on breach

- **Push notification** (`@getpaseo/protocol/resource-monitor-notification`, mirrors `token-burn-notification.ts`): per-agent pushes report both current memory and CPU regardless of which leg fired, since a tree heavy enough to trip one is usually pushing the other too. More than 3 agent breaches in one sweep collapse into a single batched push; each agent still gets its own live alert and, if `notifyAgent` is on, its own steered message. The two machine-level legs always push individually — there's no agent to batch them against.
- **Live `resourceAlert`** on the agent payload (`AgentSnapshotPayloadSchema`/`AgentListItemPayloadSchema`), additive-optional and deliberately not part of the closed `attentionReason` enum — same treatment as `tokenBurnAlert`. Live-only: cleared on rewind, never persisted, and `agent-state-bucket.ts` treats it as attention-worthy alongside `tokenBurnAlert`.
- **A message into the agent's own conversation**, when `notifyAgent` is on (default true): one steered system message per episode, reusing the same `isSystemInjectedEnvelope`/`sendPromptToAgent` path chat mentions and notify-on-finish use (`activeTurnBehavior: "steer"`, `unarchive: false`) — not a new delivery mechanism. The orphan-build-daemon episode is push-only; there's no single agent to steer a message into, so its push body names the fix directly (`./gradlew --stop`).

## Why this is a separate monitor from token burn

Token burn reads provider-reported usage per turn; it has no visibility into what a tool call spawned. A `git push` running heavy pack compression, or a Gradle daemon still resident from a build ten minutes ago, never shows up in provider token accounting — it only shows up in `ps`. The two monitors share a shape (`agent/token-burn-detector.ts` and `agent/sustained-breach-detector.ts` are structurally the same state machine) but sample entirely different data.
