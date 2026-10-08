import path from "node:path";

import { KnowledgeBaseConfigSchema } from "../persisted-config.js";

/**
 * `knowledgeBase` (docs/knowledge-base.md, KTD-14). Off by default; a section that does not match
 * `KnowledgeBaseConfigSchema` disables the feature and reports why, the `agents.jev` pattern
 * (`jev/config.ts`), instead of rejecting the rest of config.json.
 */

/** The Basic Memory command name. Resolved against PATH by the sidecar (KTD-3), not here. */
export const DEFAULT_BASIC_MEMORY_COMMAND = "basic-memory";

export interface ResolvedKnowledgeBaseConfig {
  enabled: boolean;
  notesDir: string;
  basicMemory: {
    command: string;
    semanticSearch: boolean;
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function defaultConfig(paseoHome: string): ResolvedKnowledgeBaseConfig {
  return {
    enabled: false,
    notesDir: path.join(paseoHome, "knowledge"),
    basicMemory: { command: DEFAULT_BASIC_MEMORY_COMMAND, semanticSearch: true },
  };
}

/**
 * Where `knowledgeBase` breaks `KnowledgeBaseConfigSchema`, as `knowledgeBase.<path>: <message>`
 * lines. Messages name what was expected, never the value. Empty when the section is absent or
 * valid.
 */
export function knowledgeBaseConfigIssues(section: unknown): string[] {
  if (section === undefined) return [];
  const result = KnowledgeBaseConfigSchema.safeParse(section);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const where = ["knowledgeBase", ...issue.path.map(String)].join(".");
    return issue.code === "unrecognized_keys"
      ? `${where}: unknown key(s) ${issue.keys.join(", ")}`
      : `${where}: ${issue.message}`;
  });
}

export interface ResolveKnowledgeBaseConfigOptions {
  /** `PASEO_HOME`, for the default `notesDir`. */
  paseoHome: string;
  /** Called, with the joined issues, when the section exists but does not match the schema. */
  onDisabledByConfig?: (reason: string) => void;
}

/**
 * `raw` is `config.json`'s `knowledgeBase` value, read as written (`PersistedConfigSchema`
 * accepts any shape here). A section that fails `KnowledgeBaseConfigSchema` disables the feature
 * regardless of its own `enabled` value; an absent section is disabled with no reason, the
 * ordinary off-by-default state.
 */
export function resolveKnowledgeBaseConfig(
  raw: unknown,
  options: ResolveKnowledgeBaseConfigOptions,
): ResolvedKnowledgeBaseConfig {
  const fallback = defaultConfig(options.paseoHome);
  const issues = knowledgeBaseConfigIssues(raw);
  if (issues.length > 0) {
    options.onDisabledByConfig?.(issues.join("; "));
    return fallback;
  }

  const section = record(raw);
  const basicMemory = record(section["basicMemory"]);
  return {
    enabled: bool(section["enabled"], fallback.enabled),
    notesDir: nonEmptyString(section["notesDir"], fallback.notesDir),
    basicMemory: {
      command: nonEmptyString(basicMemory["command"], fallback.basicMemory.command),
      semanticSearch: bool(basicMemory["semanticSearch"], fallback.basicMemory.semanticSearch),
    },
  };
}
