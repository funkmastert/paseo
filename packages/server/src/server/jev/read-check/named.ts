import path from "node:path";

/**
 * R2, KTD-3 (docs/jev.md, Feature 16): a read whose path, or file name, the reader was already
 * told about or just talked about is `needed` without asking JEV. Deterministic and free, and
 * never wrong in the costly direction: it can only turn a would-skip into a needed read, never
 * the reverse. Pure.
 */

const MIN_NAMED_BASENAME_CHARS = 6;

/** Too common, or too likely to appear for reasons that say nothing about this file. */
const GENERIC_BASENAMES = new Set([
  "index.ts",
  "index.js",
  "index.tsx",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "readme.md",
  "skill.md",
  "package.json",
  "tsconfig.json",
  "__init__.py",
]);

export interface NamedReadPaths {
  /** As the tool named it: relative or absolute, whichever the agent spelled. */
  namedPath: string;
  /** Relative to the agent's cwd. */
  displayPath: string;
  /** Absolute, for the base-name rule. */
  realPath: string;
}

export interface NamedReadContext {
  /**
   * The reader's own brief or task, the current turn's latest prompt, and recent assistant text
   * (R2) — never the file's own excerpt or outline: a path mentioned only inside the content
   * being judged says nothing about whether the agent already knew to expect it.
   */
  texts: readonly (string | null | undefined)[];
}

/** Whether `context` already named this read's path (R2). */
export function isNamedRead(paths: NamedReadPaths, context: NamedReadContext): boolean {
  const haystack = context.texts.filter((text): text is string => Boolean(text)).join("\n");
  if (haystack.length === 0) return false;
  if (haystack.includes(paths.namedPath) || haystack.includes(paths.displayPath)) return true;
  const baseName = path.basename(paths.realPath);
  if (baseName.length < MIN_NAMED_BASENAME_CHARS) return false;
  if (GENERIC_BASENAMES.has(baseName.toLowerCase())) return false;
  return haystack.includes(baseName);
}
