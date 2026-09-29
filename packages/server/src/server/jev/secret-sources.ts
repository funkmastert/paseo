import { readFileSync } from "node:fs";

import { parseEnvFileValue } from "../../services/quota-fetcher/providers/openai-api.js";
import { expandUserPath } from "../path-utils.js";
import { isSecretName, type JevSecretValue } from "./redact.js";

/**
 * The exact values the daemon holds that must never reach JEV (docs/jev.md, "Exact values the
 * daemon holds"). Bootstrap wires the sources; the service rebuilds the set with its config
 * snapshot, at most every 5 seconds and only when a call is made.
 */
export interface JevSecretSources {
  /** Names and values of the daemon's environment at startup, captured before the key was removed. */
  startupEnv: Readonly<Record<string, string | undefined>>;
  /** `agentMcpAuthToken` and `mcpGatewayAuthToken`, one per run. */
  runTokens: readonly string[];
  /** The relay secret key and the daemon password as configured (hash or plain text). */
  daemonSecrets: () => readonly (string | null | undefined)[];
  /** Every string the MCP gateway token store holds (`McpGatewayTokenStore.listSecretValues`). */
  gatewayTokens: () => readonly string[];
  /** The parsed `config.json`, for provider `env` blocks and `agents.providerUsage.openaiApi`. */
  rawConfig: () => Record<string, unknown> | null;
  readFile?: (filePath: string) => string;
}

const OPENAI_DEFAULT_KEY_ENVS = ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY"];
const OPENAI_DEFAULT_ENV_FILE = "~/.config/openai/env";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Any name containing one of these is collected, on top of the secret-name rule. */
const SECRET_ENV_WORD_RE = /token|secret|passw|credential|authorization|api_?key/i;
/** The daemon's cwd: as an exact value it would turn every path under it into `[redacted:exact]/…`. */
const NOT_SECRET_ENV_NAMES = new Set(["PWD", "OLDPWD"]);

/**
 * Which environment variables' values are collected as exact secrets. Wider than the secret-name
 * rule for assignments (`NGROK_AUTHTOKEN`, `GITHUB_TOKEN_2`, `SECRET_KEY_BASE`), since a value
 * collected in error is only redacted where it appears, while a missed one is sent.
 */
export function isSecretEnvName(name: string): boolean {
  if (NOT_SECRET_ENV_NAMES.has(name.toUpperCase())) return false;
  return isSecretName(name) || SECRET_ENV_WORD_RE.test(name);
}

function secretEnvValues(env: Readonly<Record<string, unknown>>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && isSecretEnvName(name)) values.push(value);
  }
  return values;
}

function openAiUsageKeys(
  rawConfig: Record<string, unknown> | null,
  startupEnv: JevSecretSources["startupEnv"],
  readFile: (filePath: string) => string,
): string[] {
  const openaiApi = record(record(record(rawConfig?.["agents"])["providerUsage"])["openaiApi"]);
  const names = [openaiApi["adminKeyEnv"], openaiApi["keyEnv"]]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  const keyEnvs = names.length > 0 ? names : OPENAI_DEFAULT_KEY_ENVS;
  const envFile =
    typeof openaiApi["envFile"] === "string" && openaiApi["envFile"].trim()
      ? openaiApi["envFile"].trim()
      : OPENAI_DEFAULT_ENV_FILE;
  const values: string[] = [];
  let fileText: string | null = null;
  try {
    fileText = readFile(expandUserPath(envFile));
  } catch {
    fileText = null;
  }
  for (const name of keyEnvs) {
    const fromEnv = startupEnv[name];
    if (typeof fromEnv === "string") values.push(fromEnv);
    const fromFile = fileText === null ? null : parseEnvFileValue(fileText, name);
    if (fromFile) values.push(fromFile);
  }
  return values;
}

function providerEnvValues(rawConfig: Record<string, unknown> | null): string[] {
  const providers = record(record(rawConfig?.["agents"])["providers"]);
  const values: string[] = [];
  for (const provider of Object.values(providers)) {
    values.push(...secretEnvValues(record(record(provider)["env"])));
  }
  return values;
}

/**
 * Every exact value, labelled `exact`. A source that throws contributes nothing and the others
 * still count; the redactor's patterns stay behind it as the backstop.
 */
export function collectJevSecretValues(
  sources: JevSecretSources,
  jevKey: string | null,
): JevSecretValue[] {
  const readFile = sources.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const collected: (string | null | undefined)[] = [jevKey, ...sources.runTokens];
  const attempt = (read: () => readonly (string | null | undefined)[]) => {
    try {
      collected.push(...read());
    } catch {
      // A broken source drops its values only.
    }
  };
  attempt(() => secretEnvValues(sources.startupEnv));
  attempt(sources.daemonSecrets);
  attempt(sources.gatewayTokens);
  attempt(() => {
    const rawConfig = sources.rawConfig();
    return [
      ...providerEnvValues(rawConfig),
      ...openAiUsageKeys(rawConfig, sources.startupEnv, readFile),
    ];
  });
  return collected
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => ({ kind: "exact", value }));
}
