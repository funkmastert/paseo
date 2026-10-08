import type MarkdownIt from "markdown-it";
import type { RuleInline } from "markdown-it/lib/parser_inline.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type { KnowledgeBaseNoteSummary } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { createMarkdownParser } from "@/utils/markdown-parser";

/**
 * Markdown for knowledge-base notes: the shared parser plus two rules.
 *
 * `[[Target]]`, `[[Target|label]]` and `[[Target#Heading]]` become links to the note they name,
 * resolved by title, permalink or file name the way Basic Memory and Obsidian resolve them. An
 * unresolved one stays plain text. `- [category] text` observations (KTD-6) get their category
 * split into a `kb_category` token so the reader can draw it as a tag.
 *
 * Both run on agent-written text, so neither backtracks (KTD-9): the wiki-link scan is a bounded
 * character loop and the category pattern is anchored with one bounded negated class.
 */

const KNOWLEDGE_NOTE_HREF_PREFIX = "paseo-kb-note:";
/** Longest `[[...]]` body the scan considers; anything longer is not a link. */
const MAX_WIKI_LINK_LENGTH = 200;
const OBSERVATION_CATEGORY = /^\[([^[\]\n]{1,40})\] /;
const CHECKBOX_MARKS = new Set([" ", "x", "X"]);

export interface WikiLinkTarget {
  path: string;
  title: string;
}

export type WikiLinkResolver = (target: string) => WikiLinkTarget | null;

export function knowledgeNoteHref(path: string): string {
  return `${KNOWLEDGE_NOTE_HREF_PREFIX}${encodeURIComponent(path)}`;
}

export function parseKnowledgeNoteHref(href: string): string | null {
  if (!href.startsWith(KNOWLEDGE_NOTE_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(KNOWLEDGE_NOTE_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function stripMarkdownExtension(value: string): string {
  return value.endsWith(".md") ? value.slice(0, -3) : value;
}

function baseName(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

/** Titles win over permalinks, permalinks over bare file names, when two notes share a key. */
export function createWikiLinkResolver(
  notes: readonly KnowledgeBaseNoteSummary[],
): WikiLinkResolver {
  const byKey = new Map<string, WikiLinkTarget>();
  function add(key: string, note: KnowledgeBaseNoteSummary): void {
    const normalized = lookupKey(key);
    if (normalized.length === 0 || byKey.has(normalized)) return;
    byKey.set(normalized, { path: note.path, title: note.title });
  }
  for (const note of notes) add(note.title, note);
  for (const note of notes) {
    add(note.permalink, note);
    add(stripMarkdownExtension(note.path), note);
  }
  for (const note of notes) {
    add(baseName(note.permalink), note);
    add(baseName(stripMarkdownExtension(note.path)), note);
  }
  return (target) => {
    const headingIndex = target.indexOf("#");
    const name = headingIndex === -1 ? target : target.slice(0, headingIndex);
    return byKey.get(lookupKey(stripMarkdownExtension(name))) ?? null;
  };
}

export interface ScannedWikiLink {
  /** The text between the brackets, before any `|label`. */
  target: string;
  label: string;
  /** Index just past the closing `]]`. */
  end: number;
}

/** Reads a `[[...]]` starting at `pos`, or null. Stops at the first bracket or line break. */
export function scanWikiLink(src: string, pos: number): ScannedWikiLink | null {
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return null;
  const bodyStart = pos + 2;
  const limit = Math.min(src.length, bodyStart + MAX_WIKI_LINK_LENGTH);
  for (let index = bodyStart; index < limit; index += 1) {
    const code = src.charCodeAt(index);
    if (code === 0x5b || code === 0x0a || code === 0x0d) return null;
    if (code !== 0x5d) continue;
    if (src.charCodeAt(index + 1) !== 0x5d || index === bodyStart) return null;
    const body = src.slice(bodyStart, index);
    const pipeIndex = body.indexOf("|");
    const target = pipeIndex === -1 ? body : body.slice(0, pipeIndex);
    const label = pipeIndex === -1 ? body : body.slice(pipeIndex + 1);
    if (target.trim().length === 0 || label.trim().length === 0) return null;
    return { target, label, end: index + 2 };
  }
  return null;
}

export interface ObservationCategory {
  category: string;
  /** Everything after `]`, starting with its space. */
  rest: string;
}

export function parseObservationCategory(text: string): ObservationCategory | null {
  const match = OBSERVATION_CATEGORY.exec(text);
  if (!match) return null;
  const category = match[1];
  if (CHECKBOX_MARKS.has(category) || category.trim().length === 0) return null;
  return { category, rest: text.slice(match[0].length - 1) };
}

function wikiLinkInlineRule(resolve: WikiLinkResolver): RuleInline {
  return (state, silent) => {
    const link = scanWikiLink(state.src, state.pos);
    if (!link) return false;
    if (!silent) {
      const target = resolve(link.target);
      if (target) {
        const open = state.push("link_open", "a", 1);
        open.attrs = [["href", knowledgeNoteHref(target.path)]];
        const text = state.push("text", "", 0);
        text.content = link.label;
        state.push("link_close", "a", -1);
      } else {
        state.pending += state.src.slice(state.pos, link.end);
      }
    }
    state.pos = link.end;
    return true;
  };
}

/** Runs after `inline` and before `linkify`, so the text after the category still linkifies. */
function observationCategoryCoreRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "inline") continue;
    if (tokens[index - 1].type !== "paragraph_open") continue;
    if (tokens[index - 2].type !== "list_item_open") continue;
    const first = token.children?.[0];
    if (!token.children || first?.type !== "text") continue;
    const observation = parseObservationCategory(first.content);
    if (!observation) continue;
    const category = new state.Token("kb_category", "", 0);
    category.content = observation.category;
    const rest = new state.Token("text", "", 0);
    rest.content = observation.rest;
    token.children.splice(0, 1, category, rest);
  }
}

export function createKnowledgeMarkdownParser(resolve: WikiLinkResolver): MarkdownIt {
  const md = createMarkdownParser({ linkify: true });
  md.inline.ruler.before("link", "kb_wiki_link", wikiLinkInlineRule(resolve));
  md.core.ruler.after("inline", "kb_observation_category", observationCategoryCoreRule);
  return md;
}
