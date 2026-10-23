# Arena rankings test fixtures

Small captures from the Hugging Face datasets-server JSON API for
`lmarena-ai/leaderboard-dataset` (CC-BY-4.0), 2026-10-08 publish. Each file is
a trimmed `/rows` response: a handful of rows from one board, enough to cover
a matched alias, an unmatched name, and the vote floor.

- `agent-overall.json` — `config=agent`, category `overall` (the agent board's
  `score`/`score_ci_*` shape).
- `text-style-control-coding.json` — `config=text_style_control`, category
  `coding` (the text board's `rating`/`rating_lower`/`rating_upper` shape).
- `webdev-webdev-react.json` — `config=webdev`, category `webdev-react`.

Credit: LMArena leaderboard dataset (CC-BY-4.0).
