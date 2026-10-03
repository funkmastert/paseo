# Refocus

A long session drifts. The subtask in front of an agent starts to feel like the goal, and after a compaction the agent's picture of its assignment is a summary. Paseo's system prompt survives compaction, but the assignment does not: it was the first user message, and compaction summarises it with everything else. Refocus restates the assignment word for word from the daemon's own timeline and asks the agent three short questions about it. `AgentRefocus` lives in `packages/server/src/server/agent/agent-refocus.ts`.

It is adapted from OpenRig's refocus hook (`packages/daemon/assets/plugins/openrig-core/hooks/scripts/refocus.cjs`, see its `docs/reference/refocus-channel.md`). That hook measures transcript growth on Claude's `Stop` and `UserPromptSubmit` hooks and marks a refocus due after about 2.6MB, or after `PostCompact` on Claude and Codex. It delivers only at `UserPromptSubmit`, as `additionalContext` on a prompt the seat was receiving anyway. Paseo keeps the triggers and the delivery rule and drops the tmux hook plumbing.

## It never starts a turn

A due refocus waits for the next prompt some other surface sends: a person's message, a notify-on-finish, a schedule fire, a compaction restore. Every one of those goes through `startAgentRun` in `agent/agent-prompt.ts`, which asks `AgentManager.interceptPromptForDispatch` whether to add anything. When a refocus is due, the block is appended to that prompt as a `<paseo-system>` section. If the dispatch fails, the refocus is put back for the next prompt.

Sending it as its own prompt would be wrong twice. On an idle agent the steer path starts a turn (the reason `AgentResourceMonitor` only steers running agents). On a leader, every turn re-reads the whole context: at 967K tokens that is about 97K weighted tokens per firing to deliver a few hundred.

The cost is that an agent that gets no further prompt never sees it. A worker doing one long turn and then finishing is the usual case. OpenRig has the same limit.

## Triggers

- **Growth.** The sum of rises in `contextWindowUsedTokens` since the last refocus (every provider reports it on `usage_updated`), measured against `growthTokens` (default 300K, which is about OpenRig's 2.6MB). The number counts new conversation, not spend: `totalTokens` is mostly cache re-reads (see [token-burn.md](token-burn.md)). A drop in context is a compaction or a rewind: the smaller context becomes the baseline and counts as no growth. Claude's sidechain frames are routed away before usage is read, so a subagent's context does not show up as a rise.
- **Compaction.** A `compaction` timeline item with status `completed` (Claude's `compact_boundary`, Codex's compaction item). It replaces a pending growth refocus. Compactions replayed from history do not count.

The first usage reading after the daemon starts, or after refocus is turned on, is a baseline. State is in memory only, so a restart drops a pending refocus.

## What the agent sees

```
<paseo-system>
Refocus (your context was just compacted).
What you now remember of your assignment is a summary. Here it is as it was given.

Your assignment (the first message of this conversation):
<assignment>…</assignment>

The most recent direction you were given. Where it differs from the assignment, it wins:
<latest-direction>…</latest-direction>

Before your next step, answer these in two or three lines of your reply, then carry on:
1. What outcome is this work for? …
2. Does what you are doing right now move that outcome? …
3. What have you concluded without checking it at the source?

This is an automatic Paseo check (agents.refocus), not a new task and not a correction.
</paseo-system>
```

"Latest direction" is the newest user message that is not a `<paseo-system>` envelope. A leader redirected by a person is pulled back to the redirect, not the obsolete first brief. Notify-on-finish reports are not direction. An earlier refocus riding on a message is stripped before that message is quoted.

The block shows in the timeline as part of the message it rode on, so the person reading the agent sees it too.

## Cost per firing

The block is about 220 tokens with a one-line assignment and about 1K at the excerpt caps (`excerptChars` 2,000 for the assignment, half that for the latest direction). The carrying request pays for it once as a cache write, and the agent's two- or three-line answer is about 150 output tokens. In weighted tokens that is at most about 2K per firing. Every later request re-reads the block from cache at about 100 weighted tokens until the next compaction. On a 967K leader that is about 2% of the request that carries it and 0.1% of each request after. A leader growing from empty to 967K gets about three growth refocuses, plus one per compaction.

## Composing with leader compaction

Leader compaction runs prepare → idle-gated `/compact` → restore. Refocus needs no hook of its own there:

1. **Prepare** is an ordinary prompt. If a growth refocus is due, it rides along. That does no harm: the agent restates the outcome while it writes down its state.
2. **`/compact …`** is skipped. A slash command reads the rest of the prompt as arguments, so an appended block would become summarisation instructions. The refocus stays pending.
3. **The compaction** marks a compaction refocus due, replacing any growth refocus.
4. **Restore** carries it. Restore should send the working state that prepare saved and leave the assignment out: refocus already quotes it from the daemon's timeline, which the compaction did not touch. The restore stays one turn and one message.

Durable finish notifications are prompts like any other, so they can carry a refocus too. Nothing about them needs to change.

## Turning it on

Off by default. Config lives under `agents.refocus` and is live-toggleable like its siblings. Turn on `dryRun` first: it logs `Refocus (dry run): would append to this prompt` with the block it would have sent and consumes the refocus. The log then shows the real cadence without changing any prompt.

| Key            | Default  | Meaning                                                             |
| -------------- | -------- | ------------------------------------------------------------------- |
| `enabled`      | `false`  | Absent or false: nothing is measured or sent                        |
| `dryRun`       | `false`  | Log each refocus with its block; leave the prompt alone             |
| `growthTokens` | `300000` | New context tokens since the last refocus before another is due     |
| `onCompaction` | `true`   | A completed compaction makes a refocus due                          |
| `scope`        | `"all"`  | `"topLevelOnly"` skips agents created by another agent              |
| `excerptChars` | `2000`   | Characters of the assignment quoted; the latest direction gets half |

`agents.*` sections are strict: a daemon built before this key existed rejects the whole config file. Add the key only once the running daemon has this build.

`grep '"module":"refocus"' daemon.log` shows every refocus that became due, was delivered, or was put back.
