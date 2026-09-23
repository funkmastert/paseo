import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSkillsStatus,
  type SkillSelection,
} from "../../orchestration-skills/internal/operations.js";
import { resolveSkillTargets } from "../../orchestration-skills/internal/paths.js";
import { PersistedConfigSchema, stripRemovedConfigFields } from "../../persisted-config.js";
import type { DoctorConfigIssue, DoctorContext, DoctorFacts, DoctorProbes } from "./context.js";
import { createRealProbes } from "./probes.js";

/** Reads `config.json` without the loader's side effects (it writes a default and chmods). */
export function readRawConfig(paseoHome: string): {
  rawConfig: Record<string, unknown> | null;
  rawConfigError: string | null;
} {
  const file = path.join(paseoHome, "config.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { rawConfig: null, rawConfigError: null }
      : { rawConfig: null, rawConfigError: `Cannot read ${file}: ${(error as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { rawConfig: null, rawConfigError: `${file} is not a JSON object.` };
    }
    return { rawConfig: parsed as Record<string, unknown>, rawConfigError: null };
  } catch (error) {
    return {
      rawConfig: null,
      rawConfigError: `Invalid JSON in ${file}: ${(error as Error).message}`,
    };
  }
}

/** The same parse the daemon runs at startup and reload, minus its side effects. */
export function validateConfigAgainstBuild(raw: unknown): DoctorConfigIssue[] {
  const result = PersistedConfigSchema.safeParse(stripRemovedConfigFields(raw));
  if (result.success) return [];
  return result.error.issues.flatMap((issue): DoctorConfigIssue[] => {
    const at = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: at,
        message: `unrecognized key "${key}"`,
        unknownKey: key,
      }));
    }
    return [{ path: at, message: issue.message }];
  });
}

function skillSelectionFrom(raw: Record<string, unknown> | null): SkillSelection {
  const agents = raw?.["agents"] as Record<string, unknown> | undefined;
  const skills = agents?.["skills"] as Record<string, unknown> | undefined;
  const selection = skills?.["selection"] as Record<string, unknown> | undefined;
  if (selection?.["mode"] === "custom" && Array.isArray(selection["skills"])) {
    return {
      mode: "custom",
      skills: selection["skills"].filter((s): s is string => typeof s === "string"),
    };
  }
  return { mode: "all" };
}

export interface BuildDoctorContextInput {
  facts: Omit<DoctorFacts, "validateConfig" | "configSchemaOwner" | "loadSkillsStatus"> &
    Partial<Pick<DoctorFacts, "validateConfig" | "configSchemaOwner" | "loadSkillsStatus">>;
  paseoHome: string;
  deep?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  probes?: DoctorProbes;
}

export function buildDoctorContext(input: BuildDoctorContextInput): DoctorContext {
  const home = input.home ?? os.homedir();
  const { rawConfig, rawConfigError } = readRawConfig(input.paseoHome);
  return {
    home,
    paseoHome: input.paseoHome,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    now: input.now ?? Date.now,
    deep: input.deep ?? false,
    rawConfig,
    rawConfigError,
    probes: input.probes ?? createRealProbes(),
    facts: {
      validateConfig: validateConfigAgainstBuild,
      configSchemaOwner: input.facts.source === "daemon" ? "the running daemon" : "this CLI build",
      loadSkillsStatus: () =>
        getSkillsStatus(resolveSkillTargets(home), skillSelectionFrom(rawConfig)),
      ...input.facts,
    },
  };
}
