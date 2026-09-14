# Token burn

The daemon tracks how fast each agent spends tokens and warns when one runs away. Two consumers read the same signal: the relative badge in agent lists (`packages/app/src/utils/token-burn-tone-model.ts`) and the absolute-threshold monitor that pushes notifications (`packages/server/src/server/agent-token-burn-monitor.ts`).

## The unit is cost-weighted tokens

Every burn delta goes through `weighTokenUsage` in `packages/server/src/server/agent/token-rate-tracker.ts`: fresh input 1, cache write 1.25, cache read 0.1, output 5 (Anthropic's list-price ratios). `recentTokenRate` and `totalTokens` on the wire are in this unit, not raw tokens.

Raw counting is what made the monitor cry wolf. A Claude agent re-reads its whole context from cache on every tool-call step, so a 300K-context agent answering a one-line question reported 1.18M "tokens" for 851 tokens of real traffic. That single turn read as 237K tokens/min for five straight minutes and tripped the rate alert on an idle agent; the 5M cumulative alert fired every couple of dozen steps on any long-lived session.

## How deltas arrive

- **Claude** records per API request while a turn runs: `message_start` carries the input side, `message_delta` the output count, and the adapter emits a daemon-internal `token_burn_delta` stream event per request. The per-turn `turnTokenDelta` on `turn_completed` is only the fallback for a run without partial messages, so a turn is never counted twice.
- **Codex** weights its per-turn `last` usage the same way.
- **OpenCode and ACP** diff cumulative totals and have no cache breakdown, so they stay raw. Their agents do not re-read a cached context per step, so the distortion above does not apply to them.
- **OMP and Pi** report nothing; the rate leg never fires for them.

`agent-manager.ts` folds both event kinds into the same 30-second ring and lifetime total. Both are live-only: cleared on rewind, never persisted.

## Monitor legs

Config lives under `agents.tokenBurnMonitor` (`persisted-config.ts`); defaults are 50K weighted tokens/min sustained for 3 sweeps, and 5M weighted tokens per session, ratcheting to the next multiple.

- **Rate** is evaluated only for agents that are mid-turn. The trailing-window average stays flat for up to five minutes after the last request, so an idle agent can never be "burning"; `sustainedMinutes` alone filters nothing.
- **Total** applies regardless of lifecycle.

Push copy distinguishes the two ("burning tokens fast" versus "has used a lot of tokens", `packages/protocol/src/token-burn-notification.ts`). The monitor logs nothing on a breach; the push log's `Sending push notification` lines at the tick phase (`:42` when the daemon started at `:42`) are its footprint.
