# AskUserQuestion check

An agent Tyler talks to should ask him for a reply with the AskUserQuestion tool — it becomes a question card in the app he can answer from his phone, and the away reply ([jev.md](jev.md), "Feature 14") can answer it while he is out. A question or a list of options typed as plain text at the end of a turn makes him read the whole message and type a reply, and is easy to miss.

The leader's `daemon.appendSystemPrompt` already carries an "ASKING TYLER" rule asking for this. Policy text alone is advice; this check is the backstop. It is deterministic — a pure text test, no model call, no judgment call — so it costs nothing per turn.

## What it does

A root Claude agent (no `paseo.parent-agent-id` label) that ends a turn whose final assistant text asks Tyler for a reply, with no AskUserQuestion call that turn, is blocked once before the turn can end. The agent reads:

```
You ended your turn asking Tyler something in plain text. Ask it with the AskUserQuestion tool instead (load it with ToolSearch "select:AskUserQuestion" if needed): 2–4 options, your recommendation first. Do not repeat the question as text.
```

It never fires:

- on a child agent — the policy tells children to decide or report to their leader, not to ask Tyler;
- twice in the same turn (the SDK's `stop_hook_active`);
- on a turn that already called AskUserQuestion;
- on a turn with no final text to judge (a cancelled turn leaves `last_assistant_message` empty);
- when the check is off, or an agent's labels can't be resolved — every uncertainty fails open, the same way the catastrophe gate does.

## The two signals

`asksReaderForReplyInText` (`packages/server/src/server/agent/ask-in-text.ts`) strips fenced code blocks and quoted (`>`) lines first, so a `?` inside either is never judged. It fires when either holds:

- the **last paragraph** contains a sentence ending in `?` that addresses the reader: "should i", "do you want", "want me to", "which", "would you", "can you", "let me know", "your call", "or should";
- the text has a **list of two or more options** (bulleted, numbered, or a bare `Option A`/`Option B` line) **local to the end of the message** — in the last two paragraphs — together with a **question-shaped choice phrase** sitting in the paragraph right before the list, inside it, or in the message's last paragraph: "which one/option/of these", "which do you/would you/should I", "pick one", "choose between/one", "do/would you prefer", "let me know", or a line ending in `?`.

Deliberately narrow: a status report that happens to end with a rhetorical question ("Why did it fail? The cache was stale.") is a false positive worth avoiding, so a lone `?` is never enough on its own — it must address the reader, or sit beside a real list of options. Both halves of the option-list signal are kept local on purpose: a bare relative "which" ("one more deploy, which now reloads the plugin automatically") next to an unrelated bulleted list used to combine into a false positive — a status report blocked a leader's turn over a list of agent tasks that had nothing to do with "which" (#18). "which"/"pick"/"choose"/"prefer" only count in their question forms now; a bare relative "which" never does. The table in `ask-in-text.test.ts` is the source of truth for both the fires and the does-not-fire cases.

## Where it runs

Claude's `Stop` hook, next to the catastrophe gate and the read check in `providers/claude/agent.ts`'s `buildHooks`. A second hook, matched to the `AskUserQuestion` tool, marks the turn as having asked properly; it ignores a subagent's own call to the tool (`agent_id` present in the hook input), since that is not the root agent asking Tyler.

A block returns `{ decision: "block", reason }` from the `Stop` hook, which the Claude Agent SDK takes as "keep going" — the turn continues rather than ending and restarting, so the prompt cache stays warm.

Only Claude is gated in v1. Another provider's session gets the policy text in its system prompt and nothing else (R5).

## Config

`agents.askUserQuestion` in `config.json`, live-toggleable the same way as `agents.catastropheGate` and `agents.buildGate`:

```json
{
  "agents": {
    "askUserQuestion": {
      "enabled": true,
      "mode": "enforce"
    }
  }
}
```

- `enabled` (default `true`): `false` turns the check off entirely. Read once per session build, so a disabled check registers no `Stop` hook at all — the next turn after a reload picks up the change.
- `mode` (default `"enforce"`): `"log"` logs what the check would have blocked and lets the turn end unblocked, same as `buildGate`'s dry run. Read fresh on every `Stop`.

The daemon logs a `"Monitor mode"` line with `monitor: "ask-user-question"` at boot and whenever the resolved config changes; `dryRun` on that line means `mode: "log"`.

## Reading the log

Every time the check fires — block or log mode — it logs one warn line:

```sh
grep '"msg":"AskUserQuestion check: turn ended asking Tyler in plain text"' "$PASEO_HOME/daemon.log"
```

with `agentId` and `mode`. A block also shows up as a `decision: "block"` the agent reads as hook feedback; there is nothing else to correlate — the detector carries no call id, no JEV verdict, because it never calls JEV.

## Changing the rule

The detector is a table test first: add a fires/does-not-fire case to `ask-in-text.test.ts` before changing `ask-in-text.ts`. A false positive (blocking a turn that was not really asking Tyler anything) costs more here than a miss — the same tradeoff the catastrophe gate makes — so prefer narrowing a phrase list over widening it.
