# Context usage

What each agent's context window is made of, as the provider's own `/context` reports it. The composer's context meter shows the total and colours it; its popover shows the breakdown: system prompt, system tools, MCP tools, custom agents, memory files, skills, messages, the autocompact buffer and free space.

The total is what every turn re-reads. Most of this fleet's tokens are agents re-reading their own history, so the meter's job is to make a session's size visible while there is still time to hand it off.

## Where the breakdown comes from

Claude answers the Agent SDK control request `get_context_usage` (`Query.getContextUsage()`), which returns the data behind `/context`. The CLI answers it alongside the conversation, so reading it never starts a turn, never enters the model's context, and never goes through the prompt or steer path.

Never read it by sending `/context` as a prompt. A slash command sent to a busy agent makes `steerActiveTurn` answer `unavailable`, and the fallback replaces the running turn.

`AgentSession.getContextUsage({ allowStart })` asks whatever Claude process is live, including one flagged for restart. It spawns a process only when none is live and no turn is running. `ensureQuery()` retires a query flagged for restart, and doing that mid-turn would kill the turn. Other providers don't implement the method and answer `unsupported`.

`packages/server/src/server/agent/providers/claude/context-usage.ts` maps the response onto the wire shape (`packages/protocol/src/context-usage/rpc-schemas.ts`). Its tests run on real captures in `claude/test-fixtures/context-usage-*.json`. Two things the mapping does that the code can't explain:

- The CLI no longer lists the autocompact reserve as a row, but it still reports `autoCompactThreshold`. The mapping adds the reserve back as "Autocompact buffer" (window minus threshold) and takes it out of free space. "Free" therefore means room left before compaction, as `/context` used to show it.
- The rows are the CLI's own per-row estimates. `totalTokens` comes from the last request's usage, so the rows need not add up to it. Counts pass through unrounded; the app formats them.

A headless `claude -p "/context"` run was the fallback considered. It costs the same, cannot see the live session's messages, and prints rounded figures, so it isn't used.

## What a capture costs

These figures were measured on CLI 2.1.280:

| Case                           | Requests                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| Cold process                   | about 15 `count_tokens` calls, no `/v1/messages`                          |
| Warm process                   | 3 `count_tokens` calls                                                    |
| `count_tokens` failing (a 503) | about 40 `/v1/messages` calls with `max_tokens: 1` on the session's model |

`count_tokens` is free. The fallback `/v1/messages` calls bill, on the session's own model. That is why the daemon captures only what someone is looking at.

## When the daemon captures

`AgentContextUsageService` (`packages/server/src/server/context-usage/`) is the daemon-wide cache behind `agent.context_usage.read`.

| Agent state when read                                              | Answer                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Idle, and a turn ran since the last capture or it is 5 minutes old | `captured`, starting the runtime if it has to               |
| Idle, nothing changed                                              | `cached`                                                    |
| Running or initializing                                            | `cached`, or `pending` when nothing is cached. Never asked. |
| Captured less than 30 seconds ago                                  | `cached`                                                    |
| Provider without the method                                        | `unsupported`                                               |
| Capture failed or timed out (30 seconds)                           | `error`, with the last good breakdown                       |

A read marks the agent as watched for 10 minutes. A watched agent is captured again 2 seconds after each turn ends. That capture never starts a runtime, and it is skipped if the next turn has already begun. Captures run one at a time across the daemon, and concurrent readers of one agent share a capture. The cache lives in memory, so a daemon restart empties it.

## The meter

The thresholds live in `agents.contextMeter` in `config.json`. They are reloadable, and the app reads them through daemon config, so one setting covers every device:

| Key                 | Default | Effect                                      |
| ------------------- | ------- | ------------------------------------------- |
| `amberTokens`       | 200000  | amber past this many tokens                 |
| `amberPercent`      | 70      | amber at this share of the window           |
| `redTokens`         | 400000  | red past this many tokens                   |
| `redPercent`        | 80      | red at this share of the window             |
| `memoryFilesTokens` | 10000   | flag memory files larger than this in total |
| `memoryFileTokens`  | 5000    | flag any one memory file larger than this   |

`amberPercent` keeps the meter's old early warning for 200K windows, where 200K tokens would already be past red.

When the meter is amber or red, the popover says "This session re-reads ~N tokens every turn. A fresh session with a short handoff is cheaper." It uses the live total, so it shows on an older daemon too. The breakdown itself is gated on `server_info.features.agentContextUsage`. An older daemon gets no request and keeps the total-only tooltip.

The popover is the meter's existing tooltip. On web and Electron it opens on hover. On iOS and Android a tap opens it in the tooltip's `Modal`, with `TooltipContent`'s `interactive` prop set so the breakdown can scroll (see [floating-panels.md](floating-panels.md)). While it is open it asks again every 15 seconds, which is how a turn-end capture appears without reopening it.

## Capturing it

`packages/app/src/context-usage/context-usage-breakdown.browser.test.tsx` renders the popover body from the fixtures, at 390px and at desktop width, and writes `.artifacts/context-meter-*.png`:

```bash
cd packages/app && npx vitest run --project browser src/context-usage/context-usage-breakdown.browser.test.tsx
```

The SVG stub draws nothing, so the ring itself is not in the captures.
