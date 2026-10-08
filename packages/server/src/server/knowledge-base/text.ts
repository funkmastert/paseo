/**
 * Text shaping for what agents hand the knowledge base: titles, summaries and recorded entries.
 * Every pattern here runs on agent-supplied text, so each is one character class with one
 * quantifier and nothing nested (KTD-9).
 */

/** Dropped from titles before comparing (dedupe rule 2): platform agents name one initiative. */
const PLATFORM_WORDS: ReadonlySet<string> = new Set(["ios", "android", "web", "desktop", "app"]);

/** Whitespace runs, newlines included, collapsed to one space; trimmed. */
export function singleLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Dedupe rule 2: lowercased, punctuation and platform words removed. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !PLATFORM_WORDS.has(word))
    .join(" ");
}

/** A frontmatter value: plain when it is plain text, else a YAML double-quoted scalar. */
export function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ()._/-]*$/.test(value) ? value : JSON.stringify(value);
}
