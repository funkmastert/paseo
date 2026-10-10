/**
 * Detects a turn that ends by asking Tyler something in plain text, rather than with the
 * AskUserQuestion tool (docs/ask-user-question.md). Deterministic and narrow on purpose: a status
 * report that happens to end with a rhetorical question is a false positive worth avoiding, so a
 * lone `?` is not enough — it must address the reader, or sit beside a real list of options.
 */

const READER_ADDRESS_PHRASES = [
  "should i",
  "do you want",
  "want me to",
  "which",
  "would you",
  "can you",
  "let me know",
  "your call",
  "or should",
] as const;

const CHOICE_PHRASES = ["which", "pick", "choose", "prefer", "let me know"] as const;

/** Bulleted (`-`/`*`), numbered (`1.`/`1)`), or a bare `Option A` / `Option B` line. */
const LIST_ITEM_PATTERN = /^\s*(?:[-*]\s+|\d+[.)]\s+|option\s+[a-z0-9]+\b)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const READER_ADDRESS_PATTERNS = READER_ADDRESS_PHRASES.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`),
);
const CHOICE_PATTERNS = CHOICE_PHRASES.map((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`));

/** Drops fenced code blocks and quoted (`>`) lines, so a `?` inside either is never judged. */
function stripCodeAndQuotes(text: string): string {
  const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, "");
  return withoutCodeBlocks
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Splits a paragraph into sentence-like fragments, one per line and per `.`/`!`/`?` boundary. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function sentenceAddressesReader(sentence: string): boolean {
  if (!sentence.endsWith("?")) return false;
  const lower = sentence.toLowerCase();
  return READER_ADDRESS_PATTERNS.some((pattern) => pattern.test(lower));
}

function lastParagraphAsksQuestion(lastParagraph: string): boolean {
  return splitSentences(lastParagraph).some(sentenceAddressesReader);
}

function countListItems(text: string): number {
  return text.split("\n").filter((line) => LIST_ITEM_PATTERN.test(line)).length;
}

function hasChoicePhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return CHOICE_PATTERNS.some((pattern) => pattern.test(lower));
}

function hasOptionListWithChoicePhrase(text: string): boolean {
  return countListItems(text) >= 2 && hasChoicePhrase(text);
}

/**
 * R2: the final assistant text ends a turn by asking Tyler for a reply in plain text — a
 * reader-addressed question, or a list of two or more options together with a choice phrase.
 */
export function asksReaderForReplyInText(text: string): boolean {
  const cleaned = stripCodeAndQuotes(text);
  const paragraphs = splitParagraphs(cleaned);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";
  if (lastParagraphAsksQuestion(lastParagraph)) return true;
  return hasOptionListWithChoicePhrase(cleaned);
}
