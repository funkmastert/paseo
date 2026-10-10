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

/**
 * Question-shaped choice phrases for the option-list signal. "which" alone is excluded on
 * purpose — a bare relative "which" ("one more deploy, which now reloads the plugin") reads as
 * asking only because it sits near an unrelated list, which was the false positive behind #18.
 * "pick"/"choose"/"prefer" are narrowed the same way; "let me know" stays bare since it has no
 * non-question reading.
 */
const QUESTION_SHAPED_CHOICE_PATTERNS = [
  /\bwhich\s+(?:one|option|of\s+these)\b/i,
  /\bwhich\s+(?:do|would)\s+you\b/i,
  /\bwhich\s+should\s+i\b/i,
  /\bpick\s+one\b/i,
  /\bchoose\s+(?:between|one)\b/i,
  /\b(?:do|would)\s+you\s+prefer\b/i,
  /\blet\s+me\s+know\b/i,
] as const;

/** Bulleted (`-`/`*`), numbered (`1.`/`1)`), or a bare `Option A` / `Option B` line. */
const LIST_ITEM_PATTERN = /^\s*(?:[-*]\s+|\d+[.)]\s+|option\s+[a-z0-9]+\b)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const READER_ADDRESS_PATTERNS = READER_ADDRESS_PHRASES.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`),
);

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

function hasQuestionMarkLine(text: string): boolean {
  return text.split("\n").some((line) => line.trim().endsWith("?"));
}

function hasQuestionShapedChoicePhrase(text: string): boolean {
  if (QUESTION_SHAPED_CHOICE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return hasQuestionMarkLine(text);
}

function findListParagraphIndices(paragraphs: string[]): number[] {
  return paragraphs.reduce<number[]>((indices, paragraph, index) => {
    if (countListItems(paragraph) > 0) indices.push(index);
    return indices;
  }, []);
}

/**
 * R2's option-list signal: a list of two or more options together with a choice phrase that is
 * actually asking. Both halves are kept local to the end of the message — the list lives in the
 * last two paragraphs, and the choice phrase must sit in the paragraph right before the list,
 * inside it, or in the message's last paragraph. A list and an unrelated choice word anywhere
 * else in a long message must never combine into a false positive (the bug behind #18, where "one
 * more deploy, which now reloads the plugin" supplied the "which" for a list several lines away).
 */
function hasLocalOptionListWithChoicePhrase(paragraphs: string[]): boolean {
  const tailStart = Math.max(0, paragraphs.length - 2);
  const tailParagraphs = paragraphs.slice(tailStart);
  const tailListItemCount = tailParagraphs.reduce((sum, p) => sum + countListItems(p), 0);
  if (tailListItemCount < 2) return false;

  const listIndices = findListParagraphIndices(paragraphs).filter((index) => index >= tailStart);
  if (listIndices.length === 0) return false;
  const firstListIndex = listIndices[0];
  const beforeList = firstListIndex > 0 ? paragraphs[firstListIndex - 1] : "";
  const insideList = listIndices.map((index) => paragraphs[index]).join("\n\n");
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";

  const candidate = [beforeList, insideList, lastParagraph].filter(Boolean).join("\n\n");
  return hasQuestionShapedChoicePhrase(candidate);
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
  return hasLocalOptionListWithChoicePhrase(paragraphs);
}
