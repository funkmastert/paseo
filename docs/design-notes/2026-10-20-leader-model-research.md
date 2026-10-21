# Which model should run Bozeo leaders? (2026-10-20)

**Bottom line: keep Claude Opus 5.5. Confidence: high on the agent evidence, moderate overall.**

- On LMArena's Agent Arena (`agent`, publish 2026-10-19), Opus 5.5 is #1 at 0.2035 [0.1779, 0.2291]. It is the only model whose CI clears every other model's CI. #2 GPT-6 Astra tops out at 0.1739, #3 Fable 5.1 at 0.1631. It has been #1 for six straight publishes (since 10-08), but this is the first publish where it clears the field.
- On the per-signal agent boards it is #1 or tied for #1 on steerability, confirmed task outcome, praise vs complaint and bash reliability. Its one weak signal is tool hallucination (#17, though statistically tied with #1 on a tiny scale).
- Text boards do not separate the top Claude models: on `hard_prompts`, `expert`, `coding`, `instruction_following` and `longer_query` Opus 5.5 is in the top tie group. The only model that clearly beats it anywhere is Gemini 4 Argon on `multi_turn`, and Argon is in limited release with no Claude Code path.
- Vendor benchmarks agree: Opus 5.5 leads Terminal-Bench 4.0 (66.4%, independently 59.6–65.2%), and Anthropic's own table puts it ahead of Fable 5.1 on every agentic row at 40% of Fable's token price.
- What would change the answer: a new model clearing Opus 5.5's CI on `agent` by a full CI width for several publishes; an Agent Arena row for Opus 5.5 at xhigh that falls well below its Max row; or a Claude Code harness benchmark showing GPT-6 Astra or Gemini 4 Argon ahead at orchestration (none exists today).

Data: [LMArena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (CC-BY-4.0), `latest` split, pulled 2026-10-20 through the datasets-server `/rows` API with ~1.5 s spacing and 429/Retry-After backoff. Raw responses were kept outside the repo. Our cache's `publishDate` (2026-10-20) is the fetch date; the dataset's own publish date for `agent` is 2026-10-19.

---

## What a leader needs, and which boards measure it

A leader runs long Claude Code sessions: it reads code, decomposes work, writes briefs, spawns and judges Paseo children, reviews diffs, keeps state across compactions, and talks to Tyler. It runs at xhigh.

| Need                                           | Closest board                                           |
| ---------------------------------------------- | ------------------------------------------------------- |
| Driving a multi-turn coding session with tools | `agent` (aggregate of five signals)                     |
| Taking correction mid-task                     | `agent_steerability`                                    |
| Finishing what the user wanted                 | `agent_task_outcome_explicit`, `agent_praise_complaint` |
| Not inventing tools                            | `agent_tool_hallucination`                              |
| Recovering from failed shell steps             | `agent_bash_recovery_steps`, `agent_bash_reliability`   |
| Hard reasoning, judging others' work           | `text_style_control` `hard_prompts`, `expert`           |
| Following Tyler's long system prompt           | `text_style_control` `instruction_following`            |
| Long conversations                             | `text_style_control` `multiturn`                        |

Agent Arena ranks orchestrator models by causal "net improvement" (IPS score, τ̂) with 95% CIs, averaging five per-signal boards: confirmed success, praise vs complaint, steerability, bash recovery, tool hallucination ([methodology](https://arena.ai/blog/agent-arena-methodology/), published 2026-06-04, updated 2026-10-15; a methodology change landed 2026-10-01). Sessions run in Arena's own agent mode, not Claude Code or Codex, so the harness is held constant across models. That makes the board a fair model comparison and an imperfect predictor of how each model behaves inside Tyler's harness.

The `agent` config has only an `overall` category; there are no per-category agent boards to pull. The per-signal configs are the breakdown.

## Arena results

Tie rule: two models whose 95% CIs overlap are tied. "Clears" means the model's lower bound is above the other's upper bound.

### `agent` overall (publish 2026-10-19)

| #   | Model                   | Score  | 95% CI        | Sessions |
| --- | ----------------------- | ------ | ------------- | -------- |
| 1   | Claude Opus 5.5 (Max)   | 0.2035 | 0.1779–0.2291 | 11,182   |
| 2   | GPT-6 Astra (Max)       | 0.1515 | 0.1291–0.1739 | 13,792   |
| 3   | Claude Fable 5.1 (Max)  | 0.1433 | 0.1234–0.1631 | 16,607   |
| 4   | GPT-6.1 Sol (Max)       | 0.1372 | 0.1195–0.1549 | 14,746   |
| 5   | Claude Sonnet 5.5 (Max) | 0.1275 | 0.0971–0.1579 | 7,769    |
| 6   | Gemini 4 Argon (High)   | 0.1212 | 0.1101–0.1324 | 35,505   |
| 7   | GPT-6 Sol (Max)         | 0.0933 | 0.0750–0.1116 | 9,246    |
| 9   | Claude Opus 5 (Max)     | 0.0808 | 0.0641–0.0975 | 24,050   |

Opus 5.5 clears all of them. Its margin over #2 is 0.004 against a CI width of 0.051, so it wins, but not by a full width. #2 through #5 are one tie group.

**History (`full` split, 42 publishes from 2026-06-04 to 2026-10-19; every 1–6 days lately, about every 2 days since late September).** The lead is recent:

| Publishes         | #1              | Opus 5.5                                                         |
| ----------------- | --------------- | ---------------------------------------------------------------- |
| 09-24, 09-25      | Fable 5.1 (Max) | not yet ranked (released 09-22)                                  |
| 09-27 – 10-02 (4) | Fable 5.1 (Max) | #2, ranked at High; CIs overlap Fable's on every publish (a tie) |
| 10-08             | Opus 5.5 (High) | #1 at High                                                       |
| 10-12 – 10-16 (4) | Opus 5.5 (Max)  | #1, but CI overlaps #2                                           |
| 10-19             | Opus 5.5 (Max)  | #1 and clears every other model                                  |

So Opus 5.5 has been #1 for six straight publishes and has cleared the field on one. Its High row, the nearest to a leader's xhigh, also reached #1 (10-08) before Arena switched its row to Max. While Fable 5.1 led, its lower bound never got above Opus 5.5's upper bound: by the margin rule in the plan (one extra CI width, three publishes), that lead would not have moved a leader.

### Agent signal boards

| Board (publish)                       | Opus 5.5                               | Ties for #1 (overlapping CIs)                       | Opus 5.5 verdict             |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `agent_steerability` (10-19)          | #1, 0.1730 [0.1521, 0.1939]            | GPT-6 Astra, Gemini 4 Argon, Fable 5.1, GPT-6.1 Sol | tied #1                      |
| `agent_task_outcome_explicit` (10-19) | #1, 0.2137 [0.1758, 0.2516]            | Sonnet 5.5, Fable 5.1                               | tied #1                      |
| `agent_praise_complaint` (10-19)      | #1, 0.4453 [0.3459, 0.5446]            | GPT-6 Astra, GPT-6.1 Sol, Fable 5.1                 | tied #1                      |
| `agent_bash_reliability` (10-19)      | #1, 0.1562 [0.1512, 0.1613]            | Sonnet 5                                            | tied #1                      |
| `agent_bash_recovery_steps` (10-08)   | #3 (High row), 0.1355 [0.1275, 0.1436] | Sonnet 5.5 (#1), Opus 5, Fable 5.1                  | tied #1                      |
| `agent_tool_hallucination` (10-19)    | #17, 0.0058 [0.0047, 0.0069]           | GPT-6.1 Sol (#1, [0.0066, 0.0078]) overlaps         | tied, but its weakest signal |

On bash recovery, GPT-6 Astra (#17) and GPT-6.1 Sol (#21) sit far below every Claude candidate, and Gemini 4 Argon is last (#50, negative). On bash reliability, Astra is #14 and 6.1 Sol #24. A leader runs a lot of shell; this is the clearest non-Claude weakness in the data.

### Text boards (`text_style_control`, publish 2026-10-15)

| Category                            | #1                                     | Opus 5.5                     | Fable 5.1                   | GPT-6.1 Sol / GPT-6 Astra | Opus 5.5 verdict                                      |
| ----------------------------------- | -------------------------------------- | ---------------------------- | --------------------------- | ------------------------- | ----------------------------------------------------- |
| `hard_prompts`                      | Gemini 4 Argon 1548.9 [1537.9, 1559.8] | #2, 1533.0 [1524.0, 1542.0]  | #8, 1521.2 [1513.9, 1528.4] | #21 / #30                 | tied #1 with Argon; ties Fable 5.1                    |
| `expert`                            | Fable 5 (High) 1550.4                  | #5, 1538.3 [1518.2, 1558.4]  | #15, 1526.9                 | #18 / #26                 | one 12-way tie at the top                             |
| `coding`                            | Gemini 4 Argon 1559.3                  | #6, 1547.5 [1533.6, 1561.4]  | #14, 1537.1                 | #10 / #9                  | one 12-way tie at the top                             |
| `instruction_following`             | Gemini 4 Argon 1527.0                  | #2, 1518.1 [1506.3, 1530.0]  | #7, 1498.6 [1488.9, 1508.3] | #16 / #30                 | tied #1                                               |
| `industry_software_and_it_services` | Gemini 4 Argon 1561.7                  | #5, 1537.6 [1526.3, 1549.0]  | #11                         | #8 / #20                  | tied #1                                               |
| `overall`                           | Gemini 4 Argon 1523.9                  | #3, 1508.2 [1500.8, 1515.5]  | #6                          | #22 / #30                 | tied #1                                               |
| `longer_query`                      | Gemini 4 Argon 1542.6                  | #2, 1522.6 [1511.6, 1533.6]  | #8                          | #25 / #30                 | tied #1                                               |
| `multi_turn`                        | Gemini 4 Argon 1552.1 [1528.8, 1575.4] | #10, 1500.6 [1482.1, 1519.0] | #26                         | #27 / #30                 | behind Argon only; ties Fable 5 and everything usable |

`multi_turn` is the one text board where Opus 5.5 is clearly behind something: Gemini 4 Argon clears it. It is also Opus 5.5's thinnest text sample (1,088 votes), and it still ties or beats every model a leader could run, Fable 5.1 included.

Text boards rank Opus 5.5 at High, not xhigh, and compare single answers rather than sessions. They say Opus 5.5 is never clearly behind a usable model, and that Gemini 4 Argon is the strongest text model. Argon is in limited release (cyber-defense access only, per [VentureBeat](https://venturebeat.com/technology/google-unveils-gemini-4-argon-retaking-benchmark-lead-over-openai-and-anthropic-but-in-limited-release)), has no Claude Code path, and ranks #6 on `agent` with the worst bash-recovery score on the board.

### Effort mismatch

Leaders run xhigh. Arena has Opus 5.5 only at Max on `agent` and at High on text boards; GPT-6 Astra and GPT-6.1 Sol only at Max. Every candidate is therefore an effort proxy, so the comparison is like for like, but the absolute numbers overstate what an xhigh leader gets. A Max row for Opus 5.5 that is far above its xhigh behavior would be the main way this ranking misleads; there is no xhigh row to check it against.

## Claude Fable 5.1

Policy: "Fable is in no pool and is not used." This section gives the facts only.

- **Rank:** #3 on `agent` (0.1433 [0.1234, 0.1631]), clearly below Opus 5.5 (no CI overlap). Tied for #1 on steerability, task outcome and praise/complaint; #5 on bash recovery; #11 on bash reliability. On text boards it trails Opus 5.5 everywhere it appears and ties it on `hard_prompts` and `instruction_following`.
- **Vendor table:** Anthropic's Opus 5.5 launch table puts Opus 5.5 ahead of Fable 5.1 on every agentic row: Terminal-Bench 4.0 66.4% vs 55.8%, FrontierCode 54.4% vs 50.3%, CursorBench 57.8% vs 51.8%, GDPval-AA 1846 vs 1735, AutomationBench 40.0% vs 31.4%. On a long internal C-to-Rust port, Opus 5.5 finished in 9.5 h vs 12 h at 51% less cost. Anthropic also says "the gap between Opus 5.5 and Claude Fable 5.1 is narrower than these scores suggest" in its own use ([Anthropic, 2026-09-22](https://www.anthropic.com/claude-opus-5-5)).
- **Price:** Fable 5.1 is $10 in / $50 out / $0.25 cache read / $12.50 5-min cache write per MTok; Opus 5.5 is $4 / $20 / $0.20 / $5 ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), read 2026-10-20). Every component is 2.5× except cache reads (1.25×). With the fleet's measured spend mix (cache reads 64–69% of weighted spend, measured 2026-09-28), the same leader workload would cost about **1.65–1.7× as much on Fable 5.1**, before any difference in tokens used.

## Evidence beyond Arena

Dates are publication dates. Anything before 2026-08-21 (60 days) is marked **[old]**.

| Source                                                                                                                                                                                | Date                         | Finding                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Anthropic, Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)                                                                                                   | 2026-09-22                   | Terminal-Bench 4.0: Opus 5.5 66.4% (xhigh), GPT-6 Astra 57.9%, Fable 5.1 55.8%, Opus 5 52.3%. AutomationBench: Astra 41.4%, Opus 5.5 40.0%. Terminal-Bench-Science: Astra 64.6%, Opus 5.5 58.7%. Claims Opus 5.5 "delegates to subagents far more effectively" than earlier models. Vendor-run. |
| Artificial Analysis Terminal-Bench 4.0, via [tech-insider](https://tech-insider.org/terminal-bench-4-opus-5-5-gemini-argon-leaderboard-2026/) and AA's Intelligence Index v4.3        | 2026-09-07 to 2026-10-18     | Independent: Opus 5.5 59.6%, roughly level with Astra (59.1%); Fable 5.1 52.0%. A Vals AI snapshot (2026-10-18) has Opus 5.5 leading at 65.15% on its own harness.                                                                                                                              |
| [OpenAI GPT-6.1 Sol launch](https://techcrunch.com/2026/09/29/openai-launches-gpt-6-1-sol-says-it-nearly-matches-gpt-6-astra-and-costs-less/)                                         | 2026-09-29                   | "Nearly matches" Astra on agentic coding at about one-fifth Astra's price ($2 / $10). GPT-6.1 Astra was not released. Vendor claim.                                                                                                                                                             |
| GPT-6 Astra launch coverage ([DataLearner](https://www.datalearner.com/en/ai-models/pretrained-models/gpt-6-astra))                                                                   | 2026-09-03                   | $10 / $50 per MTok. Strong on computer use and terminal tasks; reviewers note headline results depend on OpenAI's own harness (ARC-AGI-3 99.9% vs 62.7% on a neutral harness).                                                                                                                  |
| [Gemini 4 Argon](https://thenewstack.io/google-gemini-4-argon/)                                                                                                                       | 2026-09-30                   | Vendor table: DeepSWE 77.9% vs Opus 5.5 74.2%; Terminal-Bench 4.0 57.4% vs 66.4%. Limited release.                                                                                                                                                                                              |
| [METR time horizons](https://metr.org/time-horizons/)                                                                                                                                 | page last updated 2026-09-08 | No entry for any current candidate; the page is no longer actively updated. Latest entries are Claude Mythos Preview (2026-05) and Opus 4.6 **[old]**. No METR-style horizon evidence exists for these models.                                                                                  |
| Orchestration benchmarks: [AgentWorld](https://arxiv.org/abs/2609.31590), [OrchestraBench](https://arxiv.org/pdf/2608.05263), [OrchBench](https://arxiv.org/pdf/2607.25656) **[old]** | 2026-07 to 2026-09           | None evaluates the current candidates. Their common finding: orchestration quality depends on preserving information across dependent tasks more than on agent count.                                                                                                                           |

Nothing outside Arena measures orchestration of subagents across the current candidates. The nearest proxies (Terminal-Bench, AutomationBench, Agent Arena) all put Opus 5.5 first or tied for first among models a leader could run.

## A non-Claude leader would mean Codex

A GPT-6 Astra or GPT-6.1 Sol leader would run in the Codex harness, not Claude Code. Today that costs:

- **Tyler's hooks stop running.** Codex app-server runs no PreToolUse hook unattended (`docs/codex-workers.md`, "Guard hook"). The AskUserQuestion `Stop` check and Claude's catastrophe-gate hook have no Codex equivalent; the guard there is a separate guarded mode.
- **Leader compaction stops working.** `AgentLeaderCompactionMonitor` drives `/compact`, a Claude Code command; only Claude agents are candidates (`docs/leader-compaction.md`). A ten-day leader without it pays for an ever-growing context.
- **The account pool and failover are Claude-shaped.** Leader routing, budget pacing and failover move Claude sessions between Claude accounts. Codex has one budget window gated at 60% (`codex.maxWindowPct`) and a three-child cap.
- **The CE skill loop, CLAUDE.md, memories and `appendSystemPrompt` policy text** are delivered through Claude Code. Each would need a Codex delivery path and a smoke test (`docs/codex-workers.md`, "smoke-test gates with a real child").
- **The classifier refuses it.** `decideModel` forces Codex guard health false for the leader role, an absolute rule.

On the evidence above, nothing would justify that cost: the Codex-side candidates rank below Opus 5.5 on `agent` and far below it on bash recovery and reliability.

## Confidence and what would change the answer

- **High** that Opus 5.5 is the best leader among models that run in Claude Code: it clears every other model on the one board that measures sessions, has led that board for six publishes, beats Fable 5.1 on every vendor agentic row at 40% of the price, and no usable model beats it on any board. The clear-the-field result is one publish old, so it could fall back into a tie; a tie still keeps Opus 5.5 under pool order.
- **Moderate** overall, because no evidence measures subagent orchestration inside Claude Code, Arena only ranks Opus 5.5 at Max/High while leaders run xhigh, and Agent Arena's methodology changed on 2026-10-01.
- **Too close to call** between the tie group behind it (Astra, Fable 5.1, 6.1 Sol, Sonnet 5.5). If Opus 5.5 became unavailable, the fallback choice inside Claude Code is Opus 5 (already second in the leader pool) or Sonnet 5.5, which ranks above Opus 5 on `agent` (0.1275 vs 0.0808, CIs overlap).
- **Would change it:** a new Claude model clearing Opus 5.5 on `agent` by a CI width for several publishes; an xhigh Agent Arena row for Opus 5.5 far below its Max row; a published orchestration benchmark run in Claude Code that reverses the order.

The feature plan that tracks this automatically is `docs/plans/2026-10-20-002-feat-arena-leader-pick-plan.md`.
