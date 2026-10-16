/**
 * The options a leader offered Tyler, read out of its own text by code. JEV may only pick one of
 * these (docs/jev.md, "Feature 14: away auto-reply"), so a reply can never name an option the
 * leader did not write.
 */

export interface OfferedOption {
  /** As the leader numbered it: "A", "2". For a question request, its 1-based position. */
  id: string;
  /** The option's own text, one line, capped. */
  label: string;
}

export interface OfferedOptions {
  options: OfferedOption[];
  /** The one option the leader marked as its recommendation, or null. */
  recommendedId: string | null;
}

export const MAX_OPTIONS = 9;
const MAX_LABEL_CHARS = 300;
const NONE: OfferedOptions = { options: [], recommendedId: null };

type ListStyle = "named" | "letter" | "number";

interface Candidate {
  style: ListStyle;
  id: string;
  label: string;
  line: string;
}

/** "Option A: …", "**Option 2** — …", "### Option B". */
const NAMED =
  /^\s*(?:[-*+]\s+)?(?:#{1,6}\s+)?[*_]*\s*option\s+([a-z]|\d{1,2})\b[*_]*\s*[:.)\-–—]?\s*(.*)$/i;
/** "A) …", "(b) …", "**C.** …". Letters A-H only, so a sentence starting "I." is not an option. */
const LETTER = /^\s*(?:[-*+]\s+)?[*_]*\(?([a-h])[).:][*_]*\s+(.+)$/i;
/** "1. …", "2) …", "(3) …". */
const NUMBER = /^\s*(?:[-*+]\s+)?[*_]*\(?(\d{1,2})[).][*_]*\s+(.+)$/;

const RECOMMENDED_IN_LINE = /\brecommend(?:ed|ation)?\b|\(preferred\)|\bmy\s+pick\b/i;
/** "I recommend option B", "Recommendation: 2", "I'd go with B". */
const RECOMMENDS_NAMED =
  /\b(?:i(?:\s+would|'d)?\s+(?:recommend|suggest|go\s+with|pick|choose|lean\s+(?:towards?|to))|my\s+recommendation(?:\s+is)?|recommendation|recommended)\s*[:\-–—]?\s*[*_]*\s*option\s+([a-z]|\d{1,2})\b/gi;
const RECOMMENDS_BARE =
  /\b(?:[Ii](?:\s+would|'d)?\s+(?:recommend|suggest|go\s+with|pick|choose|lean\s+(?:towards?|to))|[Mm]y\s+recommendation(?:\s+is)?|[Rr]ecommendation|[Rr]ecommended)\s*[:\-–—]?\s*[*_]*\s*\(?([A-H]|\d{1,2})\)?(?=[\s).,:;!*_]|$)/g;

/** One line, no bold markers, no "(recommended)" tag, no leading separator. */
function cleanLabel(text: string): string {
  const oneLine = text
    .replace(/[*_]{2,}/g, "")
    .replace(/[([]\s*recommended\s*[)\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:.)\-–—\s]+/, "")
    .trim();
  return oneLine.length > MAX_LABEL_CHARS ? `${oneLine.slice(0, MAX_LABEL_CHARS - 1)}…` : oneLine;
}

function matchLine(line: string): Candidate | null {
  const named = NAMED.exec(line);
  if (named) return { style: "named", id: named[1].toUpperCase(), label: named[2] ?? "", line };
  const letter = LETTER.exec(line);
  if (letter) return { style: "letter", id: letter[1].toUpperCase(), label: letter[2], line };
  const number = NUMBER.exec(line);
  if (number) return { style: "number", id: String(Number(number[1])), label: number[2], line };
  return null;
}

function firstIdOf(style: ListStyle): string {
  return style === "number" ? "1" : "A";
}

function nextIdAfter(style: ListStyle, id: string): string {
  if (style === "number") return String(Number(id) + 1);
  return String.fromCharCode(id.charCodeAt(0) + 1);
}

/** The last run of A, B, C… (or 1, 2, 3…) in order, with any lines between the items. */
function lastSequence(candidates: Candidate[], style: ListStyle): Candidate[] {
  let best: Candidate[] = [];
  let current: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.style !== style) continue;
    if (candidate.id === firstIdOf(style)) {
      if (current.length >= 2) best = current;
      current = [candidate];
      continue;
    }
    const last = current.at(-1);
    if (last && candidate.id === nextIdAfter(style, last.id)) current.push(candidate);
  }
  if (current.length >= 2) best = current;
  return best;
}

function namedOptions(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.style !== "named" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result.length >= 2 ? result : [];
}

function recommendedFromText(text: string, ids: ReadonlySet<string>): string | null {
  const found = new Set<string>();
  for (const pattern of [RECOMMENDS_NAMED, RECOMMENDS_BARE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      const id = /^\d+$/.test(raw) ? String(Number(raw)) : raw.toUpperCase();
      if (ids.has(id)) found.add(id);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** The options in a leader's message, or none when it offers fewer than two. */
export function parseOfferedOptions(text: string): OfferedOptions {
  const candidates = text
    .split(/\r?\n/)
    .map(matchLine)
    .filter((candidate): candidate is Candidate => candidate !== null);
  const chosen =
    [
      namedOptions(candidates),
      lastSequence(candidates, "letter"),
      lastSequence(candidates, "number"),
    ].find((list) => list.length >= 2) ?? [];
  if (chosen.length < 2 || chosen.length > MAX_OPTIONS) return NONE;
  const options = chosen.map((candidate) => ({
    id: candidate.id,
    label: cleanLabel(candidate.label),
  }));
  return { options, recommendedId: recommendedIdOf(chosen, text) };
}

/** One option marked in its own line; failing that, one named in a "I recommend X" sentence. */
function recommendedIdOf(chosen: Candidate[], text: string): string | null {
  const marked = chosen.filter((candidate) => RECOMMENDED_IN_LINE.test(candidate.line));
  if (marked.length === 1) return marked[0].id;
  if (marked.length > 1) return null;
  return recommendedFromText(text, new Set(chosen.map((candidate) => candidate.id)));
}

export interface QuestionRequestOptions extends OfferedOptions {
  /** The key the app answers under (`answers[header]`). */
  header: string;
  question: string;
  /** Option descriptions, by id, for the state. */
  descriptions: Record<string, string>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The request's only question, when it has exactly one and it is single-select. */
function singleQuestion(input: unknown): Record<string, unknown> | null {
  const questions = asRecord(input)?.["questions"];
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const item = asRecord(questions[0]);
  if (!item || item["multiSelect"] === true || !Array.isArray(item["options"])) return null;
  return item;
}

/**
 * The one question in an AskUserQuestion-style request, the shape the app's question card reads
 * (`app/src/components/question-form-card-core.ts`, `parseQuestionFormQuestions`). Null for
 * anything this job will not answer: several questions, multi-select, fewer than two options.
 */
export function parseQuestionRequest(input: unknown): QuestionRequestOptions | null {
  const item = singleQuestion(input);
  const question = readString(item?.["question"]);
  const header = readString(item?.["header"]);
  if (!item || !question || !header) return null;
  const options: OfferedOption[] = [];
  const descriptions: Record<string, string> = {};
  const marked: string[] = [];
  for (const [index, entry] of (item["options"] as unknown[]).entries()) {
    const label = readString(asRecord(entry)?.["label"]);
    if (!label) return null;
    const id = String(index + 1);
    options.push({ id, label: cleanLabel(label) });
    if (RECOMMENDED_IN_LINE.test(label)) marked.push(id);
    const description = readString(asRecord(entry)?.["description"]);
    if (description) descriptions[id] = cleanLabel(description);
  }
  if (options.length < 2 || options.length > MAX_OPTIONS) return null;
  return {
    header,
    question,
    options,
    descriptions,
    recommendedId: marked.length === 1 ? marked[0] : null,
  };
}
