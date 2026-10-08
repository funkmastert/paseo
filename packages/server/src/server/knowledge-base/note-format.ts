/**
 * The knowledge base's note model, in Basic Memory's format: YAML frontmatter plus `## Heading`
 * sections of `- [category] text` observations (KTD-6). Pure string/struct functions, no I/O —
 * `note-store.ts` is the only thing that reads or writes a file. Serialization preserves every
 * frontmatter key and section this module does not know about, and their relative order, so an
 * Obsidian edit round-trips byte-for-byte (KTD-2).
 */

export const CANONICAL_SECTIONS = [
  "Summary",
  "Links",
  "Decisions",
  "Rules",
  "Status",
  "Sessions",
  "Related",
] as const;
export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

export interface FrontmatterField {
  key: string;
  /** Raw lines exactly as they appear in the file, including the `key: value` line itself. */
  rawLines: string[];
}

export interface NoteSection {
  /** The heading line verbatim, e.g. `"## Links"`. */
  heading: string;
  bodyLines: string[];
}

export interface NoteDocument {
  frontmatter: FrontmatterField[];
  /** Lines between the closing `---` and the first `## ` heading. */
  preambleLines: string[];
  sections: NoteSection[];
  lineEnding: "\n" | "\r\n";
  trailingNewline: boolean;
}

export interface Observation {
  category: string;
  text: string;
  /** Trailing detail kept verbatim, e.g. `"(2026-10-07)"` or `"— why"`. */
  suffix?: string;
}

export function parseNote(content: string): NoteDocument {
  const lineEnding: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith(lineEnding);
  const body = trailingNewline ? content.slice(0, -lineEnding.length) : content;
  const lines = body.length === 0 ? [] : body.split(lineEnding);

  if (lines[0] !== "---") {
    throw new Error("Note is missing its opening frontmatter delimiter");
  }
  const closeIndex = lines.indexOf("---", 1);
  if (closeIndex === -1) {
    throw new Error("Note frontmatter is never closed");
  }

  const frontmatter = groupFrontmatterFields(lines.slice(1, closeIndex));
  const { preambleLines, sections } = groupSections(lines.slice(closeIndex + 1));

  return { frontmatter, preambleLines, sections, lineEnding, trailingNewline };
}

export function serializeNote(doc: NoteDocument): string {
  const frontmatterLines = doc.frontmatter.flatMap((field) => field.rawLines);
  const sectionLines = doc.sections.flatMap((section) => [section.heading, ...section.bodyLines]);
  const lines = ["---", ...frontmatterLines, "---", ...doc.preambleLines, ...sectionLines];
  const joined = lines.join(doc.lineEnding);
  return doc.trailingNewline ? joined + doc.lineEnding : joined;
}

function groupFrontmatterFields(lines: string[]): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  for (const line of lines) {
    if (isTopLevelKeyLine(line)) {
      fields.push({ key: line.slice(0, line.indexOf(":")).trim(), rawLines: [line] });
    } else if (fields.length > 0) {
      fields[fields.length - 1].rawLines.push(line);
    } else {
      // A stray line before any key is kept rather than dropped.
      fields.push({ key: "", rawLines: [line] });
    }
  }
  return fields;
}

function isTopLevelKeyLine(line: string): boolean {
  if (line.length === 0) return false;
  if (/^\s/.test(line)) return false;
  if (line.startsWith("-")) return false;
  return line.includes(":");
}

function groupSections(lines: string[]): { preambleLines: string[]; sections: NoteSection[] } {
  const preambleLines: string[] = [];
  const sections: NoteSection[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      sections.push({ heading: line, bodyLines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  return { preambleLines, sections };
}

// --- Frontmatter accessors -------------------------------------------------

export function getFrontmatterScalar(doc: NoteDocument, key: string): string | undefined {
  const field = doc.frontmatter.find((candidate) => candidate.key === key);
  if (!field) return undefined;
  const line = field.rawLines[0];
  const value = line.slice(line.indexOf(":") + 1).trim();
  return value.length === 0 ? undefined : stripQuotes(value);
}

export function getFrontmatterList(doc: NoteDocument, key: string): string[] {
  const field = doc.frontmatter.find((candidate) => candidate.key === key);
  if (!field) return [];
  const firstLine = field.rawLines[0];
  const inline = firstLine.slice(firstLine.indexOf(":") + 1).trim();
  if (inline.startsWith("[") && inline.endsWith("]")) {
    const inner = inline.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((item) => stripQuotes(item.trim()));
  }
  return field.rawLines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => stripQuotes(line.slice(2).trim()));
}

export function setFrontmatterScalar(doc: NoteDocument, key: string, value: string): NoteDocument {
  return replaceOrAppendField(doc, key, [`${key}: ${value}`]);
}

export function setFrontmatterList(
  doc: NoteDocument,
  key: string,
  values: readonly string[],
): NoteDocument {
  const rawLines =
    values.length === 0 ? [`${key}: []`] : [`${key}:`, ...values.map((value) => `  - ${value}`)];
  return replaceOrAppendField(doc, key, rawLines);
}

export function addToFrontmatterList(doc: NoteDocument, key: string, value: string): NoteDocument {
  const existing = getFrontmatterList(doc, key);
  if (existing.includes(value)) return doc;
  return setFrontmatterList(doc, key, [...existing, value]);
}

function replaceOrAppendField(doc: NoteDocument, key: string, rawLines: string[]): NoteDocument {
  const index = doc.frontmatter.findIndex((candidate) => candidate.key === key);
  const field: FrontmatterField = { key, rawLines };
  const frontmatter =
    index === -1
      ? [...doc.frontmatter, field]
      : doc.frontmatter.map((candidate, i) => (i === index ? field : candidate));
  return { ...doc, frontmatter };
}

function stripQuotes(value: string): string {
  const isQuoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return isQuoted ? value.slice(1, -1) : value;
}

// --- Sections and observations ----------------------------------------------

export function findSection(doc: NoteDocument, heading: string): NoteSection | undefined {
  const headingLine = `## ${heading}`;
  return doc.sections.find((section) => section.heading === headingLine);
}

export function parseObservationLine(line: string): Observation | null {
  const match = OBSERVATION_LINE.exec(line);
  if (!match) return null;
  const category = match[1];
  const rest = match[2];
  const dateMatch = DATE_SUFFIX.exec(rest);
  if (dateMatch) return { category, text: dateMatch[1], suffix: dateMatch[2] };
  const reasonMatch = REASON_SUFFIX.exec(rest);
  if (reasonMatch) return { category, text: reasonMatch[1], suffix: reasonMatch[2] };
  return { category, text: rest };
}

export function serializeObservationLine(observation: Observation): string {
  const suffix = observation.suffix ? ` ${observation.suffix}` : "";
  return `- [${observation.category}] ${observation.text}${suffix}`;
}

const OBSERVATION_LINE = /^-\s*\[([^\]]*)\]\s(.*)$/;
const DATE_SUFFIX = /^(.*?)\s(\(\d{4}-\d{2}-\d{2}\))$/;
const REASON_SUFFIX = /^(.*?)\s(—\s.*)$/;

/** Appends `observation`, or leaves the note unchanged if the same category and text are already there. */
export function addObservation(
  doc: NoteDocument,
  heading: string,
  observation: Observation,
): NoteDocument {
  const section = findSection(doc, heading);
  if (section && hasObservation(section, observation.category, observation.text)) return doc;
  return appendObservationLine(doc, heading, serializeObservationLine(observation));
}

function hasObservation(section: NoteSection, category: string, text: string): boolean {
  return section.bodyLines
    .map(parseObservationLine)
    .filter(isObservation)
    .some((existing) => existing.category === category && existing.text === text);
}

function isObservation(value: Observation | null): value is Observation {
  return value !== null;
}

function appendObservationLine(doc: NoteDocument, heading: string, line: string): NoteDocument {
  const headingLine = `## ${heading}`;
  const existingIndex = doc.sections.findIndex((section) => section.heading === headingLine);
  if (existingIndex !== -1) {
    const section = doc.sections[existingIndex];
    const insertAt = lastObservationLineIndex(section.bodyLines) + 1;
    const bodyLines = [
      ...section.bodyLines.slice(0, insertAt),
      line,
      ...section.bodyLines.slice(insertAt),
    ];
    const sections = doc.sections.map((candidate, i) =>
      i === existingIndex ? { ...candidate, bodyLines } : candidate,
    );
    return { ...doc, sections };
  }
  const insertIndex = canonicalInsertIndex(doc.sections, heading);
  const sections = [
    ...doc.sections.slice(0, insertIndex),
    { heading: headingLine, bodyLines: [line] },
    ...doc.sections.slice(insertIndex),
  ];
  return { ...doc, sections };
}

function lastObservationLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("- [")) return i;
  }
  return -1;
}

function canonicalInsertIndex(sections: readonly NoteSection[], heading: string): number {
  const rank = canonicalRank(heading);
  for (let i = 0; i < sections.length; i++) {
    if (canonicalRank(sections[i].heading.replace(/^##\s*/, "")) > rank) return i;
  }
  return sections.length;
}

function canonicalRank(heading: string): number {
  const index = CANONICAL_SECTIONS.indexOf(heading as CanonicalSection);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

// --- Wiki links --------------------------------------------------------------

// Not a regex: on a run of unmatched `[[` a negated-class pattern like `/\[\[([^\]]+)\]\]/g`
// still costs O(n^2), because `[^\]]+` allows `[`, so each of the n failed "[[" starts rescans to
// the end of the string looking for "]]" (KTD-9). A wiki link's grammar is "scan to the first `]`;
// it must be doubled" — a position-table scan makes that O(n) instead: `nextCloseBracket[i]` is
// the index of the next `]` at or after `i`, built once in one backward pass.
interface WikiLinkMatch {
  start: number;
  end: number;
  inner: string;
}

function findWikiLinks(text: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  const length = text.length;
  if (length < 4) return matches;
  const nextCloseBracket = buildNextCloseBracketTable(text);
  let pos = 0;
  while (pos < length - 1) {
    const start = text.indexOf("[[", pos);
    if (start === -1) break;
    const firstClose = nextCloseBracket[start + 2];
    if (firstClose >= length) break; // no `]` anywhere after; nothing later can match either.
    if (text[firstClose + 1] === "]") {
      matches.push({ start, end: firstClose + 2, inner: text.slice(start + 2, firstClose) });
      pos = firstClose + 2;
    } else {
      pos = start + 1;
    }
  }
  return matches;
}

function buildNextCloseBracketTable(text: string): Uint32Array {
  const length = text.length;
  const table = new Uint32Array(length + 1);
  table[length] = length;
  for (let i = length - 1; i >= 0; i--) {
    table[i] = text[i] === "]" ? i : table[i + 1];
  }
  return table;
}

export function extractWikiLinkTargets(text: string): string[] {
  return findWikiLinks(text).map((match) => splitWikiLinkInner(match.inner).target);
}

export function rewriteWikiLinks(text: string, oldTarget: string, newTarget: string): string {
  const matches = findWikiLinks(text);
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.start));
    const { target, rest } = splitWikiLinkInner(match.inner);
    parts.push(
      target === oldTarget ? `[[${newTarget}${rest}]]` : text.slice(match.start, match.end),
    );
    cursor = match.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function splitWikiLinkInner(inner: string): { target: string; rest: string } {
  const pipeIndex = inner.indexOf("|");
  const hashIndex = inner.indexOf("#");
  const cutCandidates = [pipeIndex, hashIndex].filter((index) => index !== -1);
  const cut = cutCandidates.length === 0 ? inner.length : Math.min(...cutCandidates);
  return { target: inner.slice(0, cut).trim(), rest: inner.slice(cut) };
}

// --- Slugs and permalinks -----------------------------------------------------

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "note" : slug;
}

export function projectPermalink(slug: string): string {
  return `projects/${slug}`;
}

export function projectNotePath(slug: string): string {
  return `projects/${slug}.md`;
}

// --- Construction, rename, merge -----------------------------------------------

export interface CreateProjectNoteInput {
  title: string;
  summary: string;
  /** Written verbatim into `created`; callers format the date so this module stays clock-free. */
  created: string;
}

export function createProjectNote(input: CreateProjectNoteInput): NoteDocument {
  const slug = slugify(input.title);
  const frontmatter: FrontmatterField[] = [
    { key: "title", rawLines: [`title: ${input.title}`] },
    { key: "type", rawLines: ["type: project"] },
    { key: "permalink", rawLines: [`permalink: ${projectPermalink(slug)}`] },
    { key: "tags", rawLines: ["tags:", "  - project"] },
    { key: "aliases", rawLines: ["aliases: []"] },
    { key: "created", rawLines: [`created: ${input.created}`] },
  ];
  const sections: NoteSection[] = CANONICAL_SECTIONS.map((heading) => ({
    heading: `## ${heading}`,
    bodyLines: heading === "Summary" && input.summary.length > 0 ? [input.summary] : [],
  }));
  return { frontmatter, preambleLines: [], sections, lineEnding: "\n", trailingNewline: true };
}

export function createInboxNote(created: string): NoteDocument {
  const frontmatter: FrontmatterField[] = [
    { key: "title", rawLines: ["title: Inbox"] },
    { key: "type", rawLines: ["type: inbox"] },
    { key: "permalink", rawLines: ["permalink: inbox"] },
    { key: "tags", rawLines: ["tags:", "  - inbox"] },
    { key: "aliases", rawLines: ["aliases: []"] },
    { key: "created", rawLines: [`created: ${created}`] },
  ];
  return {
    frontmatter,
    preambleLines: [],
    sections: [{ heading: "## Links", bodyLines: [] }],
    lineEnding: "\n",
    trailingNewline: true,
  };
}

/** Renames in place: the title, the permalink, and the old title added to `aliases`. */
export function renameNote(doc: NoteDocument, newTitle: string): NoteDocument {
  const oldTitle = getFrontmatterScalar(doc, "title");
  const withTitle = setFrontmatterScalar(doc, "title", newTitle);
  const withPermalink = setFrontmatterScalar(
    withTitle,
    "permalink",
    projectPermalink(slugify(newTitle)),
  );
  if (!oldTitle || oldTitle === newTitle) return withPermalink;
  return addToFrontmatterList(withPermalink, "aliases", oldTitle);
}

const MERGED_MARKER = "(from B)";

/** Folds `source` into `target`: links union without duplicates, decisions/rules concatenated and
 *  marked, source's title added to target's aliases. Removing source's file and rewriting other
 *  notes' links to it are note-store/service operations, not this pure step. */
export function mergeNotes(target: NoteDocument, source: NoteDocument): NoteDocument {
  let merged = mergeObservationSection(target, source, "Links", {
    dedupe: true,
    markFromSource: false,
  });
  merged = mergeObservationSection(merged, source, "Decisions", {
    dedupe: false,
    markFromSource: true,
  });
  merged = mergeObservationSection(merged, source, "Rules", {
    dedupe: false,
    markFromSource: true,
  });
  const sourceTitle = getFrontmatterScalar(source, "title");
  return sourceTitle ? addToFrontmatterList(merged, "aliases", sourceTitle) : merged;
}

interface MergeSectionOptions {
  dedupe: boolean;
  markFromSource: boolean;
}

function mergeObservationSection(
  target: NoteDocument,
  source: NoteDocument,
  heading: string,
  options: MergeSectionOptions,
): NoteDocument {
  const sourceSection = findSection(source, heading);
  if (!sourceSection) return target;
  const sourceObservations = sourceSection.bodyLines
    .map(parseObservationLine)
    .filter(isObservation);
  let result = target;
  for (const observation of sourceObservations) {
    const marked = options.markFromSource ? withFromSourceMarker(observation) : observation;
    result = options.dedupe
      ? addObservation(result, heading, marked)
      : appendObservationLine(result, heading, serializeObservationLine(marked));
  }
  return result;
}

function withFromSourceMarker(observation: Observation): Observation {
  const suffix = observation.suffix ? `${observation.suffix} ${MERGED_MARKER}` : MERGED_MARKER;
  return { ...observation, suffix };
}
