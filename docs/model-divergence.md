# Model divergence

An agent is configured with a model. Its responses say which model produced them. When the two disagree and nothing on the daemon's side explains why, the agent is running on a model nobody chose. The daemon compares them on every response and surfaces a mismatch it cannot explain.

The design is OpenRig's: detect the mismatch, do not enumerate causes. A 400 that degrades a model, an account that cannot serve it, and a CLI that quietly falls back all look identical here, and so does the cause nobody has met yet.

## What is compared

The configured side is `agent.config.model`. The observed side is the `model` on each API response in the SDK stream (`message_start` and the assistant frames of the same response, deduped by message id, `providers/claude/agent.ts`).

The init message's model is not the observed side. It is the request echoed back: a CLI that substitutes a model still reports what was asked for at init. The session's `runtimeInfo.model` is derived from it, so it cannot detect anything either.

Only the agent's own frames count. A subagent is allowed a model of its own (`parent_tool_use_id` frames are routed away before this point), and `<synthetic>` placeholders are not inferences.

## What counts as intentional

`packages/server/src/server/agent/model-divergence.ts` owns all of it. Get this wrong toward noise and the feature is ignored; get it wrong toward blind and it is decoration.

| Change                                                                               | Handled by                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setAgentModel`: a governor downgrade, a model picker, `update_agent`, a role policy | The manager records the change. The finding against the old model is dropped, and the old model stays acceptable for 2 minutes or until the first response on the new one, since `setModel` applies from the next request and the one in flight finishes on the old model. |
| An alias (`opus`, `sonnet[1m]`, `default`)                                           | The CLI resolves it, so the init message's model stands in for the alias. Only for an alias: for a concrete id the init model is the request echoed back and would vouch for a substitution.                                                                               |
| `opusplan`                                                                           | Not verified. It picks Opus or Sonnet by mode on purpose.                                                                                                                                                                                                                  |
| `[1m]`, a dated snapshot, `4.8` versus `4-8`                                         | Canonicalized before comparing. They are properties of the session or the spelling, not another model.                                                                                                                                                                     |
| Account-failover move, session reload                                                | Nothing observed before the move is evidence about the session after it, so the finding and any pending transition are dropped. A response after the move that disagrees is still a finding: a move changes where a model is served from, not which one was asked for.     |
| Account-failover import, a new agent                                                 | A new agent has a new state. Its configured model is whatever the create call set, so a successor that inherited the wrong model is a finding.                                                                                                                             |
| No model configured                                                                  | Nothing to compare. Not a finding.                                                                                                                                                                                                                                         |

Do not compare with `normalizeClaudeRuntimeModelId`. It maps ids onto the manifest for display and its fallback regex is unanchored, so `claude-opus-5-5` becomes `claude-opus-5`. That is how an Opus 5.5 agent's runtime info once read `claude-opus-5` while the CLI was serving Opus 5.5 (real stream: init, `message_start`, the assistant frame and `modelUsage` all report `claude-opus-5-5`). A comparison built on it cannot see the substitution it exists to catch. `canonicalModelId` only lowercases and strips the session suffix and the date.

## Surfaces

The state costs one string comparison per response and is always kept, on every agent. Surfacing is opt-in, so it can be turned on for everyone without a cost question.

`AgentModelDivergenceMonitor` (`agent-model-divergence-monitor.ts`) sweeps every 30 seconds and reads the manager's verdict. It never compares models itself.

- **Orchestration panel.** A "Wrong model" badge on the row, from the first unexplained response. It turns to the error colour once the mismatch persists. The wire field is `modelDivergence` on the agent snapshot and list item, additive-optional.
- **Log.** One `warn` line per agent per (configured, observed) pair: `Model divergence: agent responses report a model other than the one it was configured with`, carrying `agentId`, `configuredModel`, `observedModel`.
- **Push.** One per agent per pair, once the mismatch persists: at least 3 consecutive responses on the same wrong model over at least 60 seconds. Both, because a switch straddled by a few quick tool calls is not a persisting mismatch.

A mismatch that recovers and returns shows the badge again, without a second log line or push. A different wrong model is a new finding. Turning the monitor off removes the badges and forgets what it announced.

The badge is not attention. It does not change `attentionReason` or the state bucket; a wrong model is not a stopped agent.

## Config

Under `agents.tokenBurnMonitor.modelDivergence`, live-toggleable, independent of the token-burn monitor's own `enabled`:

| Key                | Default | What it does                                     |
| ------------------ | ------- | ------------------------------------------------ |
| `enabled`          | `false` | Nothing is surfaced while this is off            |
| `persistResponses` | `3`     | Consecutive wrong responses before a push        |
| `persistSeconds`   | `60`    | Time from the first to the latest wrong response |

`grep '"msg":"Monitor mode"' daemon.log` reports the mode, like the other monitors.

## Limits

Claude only. Other providers do not emit `model_observed`, and the state stays empty for them. The event is provider-neutral; a provider that reports per-response models can emit it.

The grace window is a fixed 2 minutes. A single response longer than that, started before a `setAgentModel`, would be flagged. The persistence thresholds keep that from pushing.

A profile that maps model names (an `ANTHROPIC_BASE_URL` gateway answering `glm-5` to a request for `claude-sonnet-5`) looks like a divergence. Leave the monitor off for such an agent, or configure the model name the gateway reports.
