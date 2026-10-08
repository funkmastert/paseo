import {
  findSection,
  getFrontmatterScalar,
  parseObservationLine,
  type NoteDocument,
} from "./note-format.js";
import { scrubText } from "./scrub.js";

/**
 * The session-start summary of a project (KTD-15, R16): title, the `## Summary` paragraph, how
 * many links and decisions the note holds, and where to read the rest. Taken once at create and
 * stored, so it must not depend on anything but the note.
 */

export const PROJECT_SUMMARY_MAX_CHARS = 800;
const TITLE_MAX_CHARS = 120;

export function buildProjectSummary(doc: NoteDocument, slug: string): string {
  const title = truncate(getFrontmatterScalar(doc, "title") ?? slug, TITLE_MAX_CHARS);
  const head = `Knowledge-base project for this session: ${title} (${slug}).`;
  const links = countable(countObservations(doc, "Links"), "link");
  const decisions = countable(countObservations(doc, "Decisions"), "decision");
  const counts = `It records ${links} and ${decisions}.`;
  const pointer = `Call kb_open("${slug}") for the links, decisions, rules and status before relying on them.`;
  const fixedLength = head.length + counts.length + pointer.length + 3;
  const summary = truncate(summaryParagraph(doc), PROJECT_SUMMARY_MAX_CHARS - fixedLength);
  const lines = summary.length > 0 ? [head, summary, counts, pointer] : [head, counts, pointer];
  return scrubText(lines.join("\n")).text;
}

/** The first paragraph of `## Summary`, on one line. */
function summaryParagraph(doc: NoteDocument): string {
  const section = findSection(doc, "Summary");
  if (!section) return "";
  const paragraph: string[] = [];
  for (const line of section.bodyLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.join(" ");
}

/** How many `- [category] text` lines sit under `## <heading>`. */
export function countObservations(doc: NoteDocument, heading: string): number {
  const section = findSection(doc, heading);
  if (!section) return 0;
  return section.bodyLines.filter((line) => parseObservationLine(line) !== null).length;
}

function countable(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
