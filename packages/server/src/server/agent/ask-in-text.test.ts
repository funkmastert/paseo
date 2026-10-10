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
];

describe("asksReaderForReplyInText", () => {
  test.each(FIRES)("fires: $note", ({ text }) => {
    expect(asksReaderForReplyInText(text)).toBe(true);
  });

  test.each(DOES_NOT_FIRE)("does not fire: $note", ({ text }) => {
    expect(asksReaderForReplyInText(text)).toBe(false);
  });
});
