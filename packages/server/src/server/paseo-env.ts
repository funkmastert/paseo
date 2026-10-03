const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

/**
 * Names that must never leave the daemon process, in any child's environment (docs/jev.md,
 * "Key"). Stripped everywhere `RUNTIME_CONTROL_ENV_KEYS` is, and also from the internal env an
 * in-process worker gets, which keeps every other variable.
 */
export const SECRET_ENV_KEYS = ["PASEO_JEV_API_KEY"] as const;

/**
 * `agents.childEnv.strip` when config names none (docs/jev.md, "Key"): the retired Biblio
 * credentials the desktop imports from the login shell. Names a provider authenticates with stay.
 */
export const DEFAULT_CHILD_ENV_STRIP: readonly string[] = ["BIBLIO_*"];

let childEnvStrip: readonly string[] = DEFAULT_CHILD_ENV_STRIP;

/** Set once at daemon start from `agents.childEnv.strip`; `undefined` restores the default. */
export function configureChildEnvStrip(names: readonly string[] | undefined): void {
  childEnvStrip = names ? [...names] : DEFAULT_CHILD_ENV_STRIP;
}

/** An exact name, or a prefix when the entry ends in `*`. */
function isStrippedChildEnvName(name: string): boolean {
  return childEnvStrip.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );
}

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function stripSecretKeys(env: ProcessEnvRecord): void {
  for (const key of SECRET_ENV_KEYS) {
    delete env[key];
  }
}

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  const sanitized = { ...baseEnv };
  stripSecretKeys(sanitized);
  return sanitized;
}

/**
 * The configured names leave the inherited env only, before the overlays: a provider whose own
 * `env` sets one of them (its `CLAUDE_CONFIG_DIR`, say) still hands it to its agents.
 */
function withoutStrippedChildEnv(baseEnv: ProcessEnvRecord): ProcessEnvRecord {
  const kept: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isStrippedChildEnvName(key)) kept[key] = value;
  }
  return kept;
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, withoutStrippedChildEnv(baseEnv), ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  stripSecretKeys(sanitized);
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  stripSecretKeys(env);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
