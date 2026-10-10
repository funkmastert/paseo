import { describe, expect, test } from "vitest";

import { asksReaderForReplyInText } from "./ask-in-text.js";

interface Case {
  note: string;
  text: string;
}

const FIRES: Case[] = [
  { note: "want me to", text: "Want me to merge it?" },
  { note: "should I ... or", text: "Should I go with A or B?" },
  {
    note: "numbered list + which/prefer, no question mark",
    text: "Which do you prefer:\n1. Rebase\n2. Merge",
  },
  {
    note: "bulleted options + let me know",
    text: "Options:\n- Option A: rebase onto main\n- Option B: merge as-is\nLet me know.",
  },
  { note: "your call", text: "Your call: ship now or wait?" },
];

const DOES_NOT_FIRE: Case[] = [
  { note: "plain status report", text: "Fixed the failing test and reran the suite.\n\nDone." },
  {
    note: "rhetorical question not in the last paragraph",
    text: "Why did it fail? The cache was stale.\n\nI'll look at the logs next.",
  },
  {
    note: "question mark inside a fenced code block",
    text: "Here's the snippet:\n\n```\nShould I retry on failure?\n```",
  },
  {
    note: "question mark inside a quoted line",
    text: "He asked in the ticket:\n\n> Should I check this in?\n\nI'll leave it as reported.",
  },
  {
    note: "bulleted summary with no choice phrase",
    text: "Changes made:\n- Fixed the parser\n- Updated the tests",
  },
  { note: "plain next-step statement", text: "Next I'll check X." },
  {
    note: "status report with a table and bullets, 'which' as a relative pronoun near a list",
    text: [
      "Three agents are running:",
      "",
      "| Agent | Doing |",
      "|---|---|",
      "| Codex PR A re-review | Confirming the two P0 holes are actually closed |",
      "| Arena rate-limit fix | So all nine boards load |",
      "| Explicit-request fix | So the ranking runs even though every spawn names a model |",
      "",
      "A background watch is also waiting for the first live workspace archives. When those land:",
      "- merge PR A if the re-review passes;",
      "- gate and merge the two arena fixes;",
      "- one more deploy, which now reloads the plugin automatically;",
      "- then check the arena shadow's picks over real spawns.",
      "",
      "Each agent reports back when done.",
    ].join("\n"),
  },
  {
    note: "which as a relative pronoun inside a list, no choice phrase",
    text: "Changes:\n- Simplified the parser\n- Removed the old flag, which was unused\n\nDone.",
  },
  {
    note: "numbered next-steps list with no question",
    text: "Next steps:\n1. Deploy to staging\n2. Run smoke tests\n3. Promote to prod",
  },
];

describe("asksReaderForReplyInText", () => {
  test.each(FIRES)("fires: $note", ({ text }) => {
    expect(asksReaderForReplyInText(text)).toBe(true);
  });

  test.each(DOES_NOT_FIRE)("does not fire: $note", ({ text }) => {
    expect(asksReaderForReplyInText(text)).toBe(false);
  });
});
