import { readFileSync, statSync } from "node:fs";
import type { Logger } from "pino";

import { parseEnvFileValue } from "../../services/quota-fetcher/providers/openai-api.js";

/**
 * The key's variable, for both providers (docs/jev.md, "Key", D5). `OPENROUTER_API_KEY` and
 * `TYPESAFE_API_KEY` are never read.
 */
export const JEV_KEY_ENV = "PASEO_JEV_API_KEY";

/** What `captureJevKeyFromEnv` hands back: whether a key was present, and its value, once. */
export interface CapturedJevEnvKey {
  readonly present: boolean;
  value(): string | null;
}

function stripKey(record: Record<string, string | undefined> | undefined): void {
  if (!record) return;
  delete record[JEV_KEY_ENV];
}

/**
 * Reads `PASEO_JEV_API_KEY` once, keeps it in this closure, and deletes it from `env` and from
 * every record in `alsoStrip`, before anything can spawn (docs/jev.md, "Key" — the same placement
 * rule as `setProcessPriorityPolicy`).
 */
export function captureJevKeyFromEnv(
  env: NodeJS.ProcessEnv,
  alsoStrip?: ReadonlyArray<Record<string, string | undefined> | undefined>,
): CapturedJevEnvKey {
  const raw = env[JEV_KEY_ENV];
  const value = typeof raw === "string" && raw.length > 0 ? raw : null;
  stripKey(env);
  for (const record of alsoStrip ?? []) stripKey(record);
  return {
    present: value !== null,
    value: () => value,
  };
}

export interface JevKeyResolution {
  key: string | null;
  /** Which source answered. Null: no key anywhere. */
  source: "env-file" | "env" | null;
}

export interface JevKeyResolver {
  /** The env file wins over the captured env; a missing or unreadable file falls back to it. */
  resolve(envFile: string): JevKeyResolution;
}

export interface JevKeyResolverOptions {
  captured: CapturedJevEnvKey;
  logger: Logger;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  statMode?: (path: string) => number | null;
}

/** Group- or other-readable, POSIX permission bits only. */
const GROUP_OR_OTHER_MODE = 0o077;

function defaultStatMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export function createJevKeyResolver(options: JevKeyResolverOptions): JevKeyResolver {
  const logger = options.logger.child({ module: "jev-key" });
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const statMode = options.statMode ?? defaultStatMode;
  const warnedPaths = new Set<string>();

  function warnIfGroupOrOtherReadable(envFile: string): void {
    if (platform === "win32") return;
    const mode = statMode(envFile);
    if (mode === null || (mode & GROUP_OR_OTHER_MODE) === 0) return;
    if (warnedPaths.has(envFile)) return;
    warnedPaths.add(envFile);
    logger.warn(
      { envFile },
      `jev: ${envFile} is readable by group or others; run \`chmod 600 ${envFile}\``,
    );
  }

  return {
    resolve(envFile: string): JevKeyResolution {
      let fileText: string | null;
      try {
        fileText = readFile(envFile);
      } catch {
        fileText = null;
      }
      if (fileText !== null) {
        warnIfGroupOrOtherReadable(envFile);
        const fromFile = parseEnvFileValue(fileText, JEV_KEY_ENV);
        if (fromFile) return { key: fromFile, source: "env-file" };
      }
      const fromEnv = options.captured.value();
      if (fromEnv) return { key: fromEnv, source: "env" };
      return { key: null, source: null };
    },
  };
}
