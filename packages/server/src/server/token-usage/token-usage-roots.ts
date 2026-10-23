import path from "node:path";
import type { TranscriptRoot } from "./token-usage-scanner.js";

/**
 * Where transcripts live: the default Claude and Codex homes, the daemon's own environment, and
 * every provider in `agents.providers` that points `CLAUDE_CONFIG_DIR` or `CODEX_HOME` somewhere
 * else (the account pool's homes). The scanner reads each real folder once, so homes that link
 * their `projects` to a shared folder cost nothing extra.
 */
export function resolveTranscriptRoots(input: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  rawConfig: Record<string, unknown> | null;
}): TranscriptRoot[] {
  const claudeHomes: unknown[] = [
    path.join(input.homeDir, ".claude"),
    input.env["CLAUDE_CONFIG_DIR"],
  ];
  const codexHomes: unknown[] = [path.join(input.homeDir, ".codex"), input.env["CODEX_HOME"]];
  for (const providerEnv of providerEnvs(input.rawConfig)) {
    claudeHomes.push(providerEnv["CLAUDE_CONFIG_DIR"]);
    codexHomes.push(providerEnv["CODEX_HOME"]);
  }
  const roots: TranscriptRoot[] = [];
  const seen = new Set<string>();
  const add = (provider: TranscriptRoot["provider"], home: unknown, leaf: string) => {
    if (typeof home !== "string" || home.trim().length === 0) return;
    const dir = path.join(expandHome(home.trim(), input.homeDir), leaf);
    if (seen.has(dir)) return;
    seen.add(dir);
    roots.push({ provider, dir });
  };
  for (const home of claudeHomes) add("claude", home, "projects");
  for (const home of codexHomes) add("codex", home, "sessions");
  return roots;
}

function providerEnvs(rawConfig: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const providers = asRecord(asRecord(rawConfig?.["agents"])?.["providers"]);
  if (!providers) return [];
  const envs: Array<Record<string, unknown>> = [];
  for (const provider of Object.values(providers)) {
    const env = asRecord(asRecord(provider)?.["env"]);
    if (env) envs.push(env);
  }
  return envs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function expandHome(dir: string, homeDir: string): string {
  if (dir === "~") return homeDir;
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return path.join(homeDir, dir.slice(2));
  return dir;
}
