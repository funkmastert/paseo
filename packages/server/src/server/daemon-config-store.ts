import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@getpaseo/protocol/messages";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

type MutableDaemonConfig = import("@getpaseo/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@getpaseo/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface SupportedMutableConfigPatch {
  relay?: { enabled?: boolean };
  mcp?: { injectIntoAgents?: boolean };
  browserTools?: { enabled?: boolean };
  providers?: MutableDaemonConfig["providers"];
  removeProviders?: string[];
  metadataGeneration?: Partial<MutableDaemonConfig["metadataGeneration"]>;
  tokenBurnMonitor?: MutableDaemonConfig["tokenBurnMonitor"];
  resourceMonitor?: MutableDaemonConfig["resourceMonitor"];
  processPriority?: MutableDaemonConfig["processPriority"];
  deviceLeases?: MutableDaemonConfig["deviceLeases"];
  artifactJanitor?: MutableDaemonConfig["artifactJanitor"];
  accountFailover?: MutableDaemonConfig["accountFailover"];
  budgetPacing?: MutableDaemonConfig["budgetPacing"];
  leaderCompaction?: MutableDaemonConfig["leaderCompaction"];
  doneJanitor?: MutableDaemonConfig["doneJanitor"];
  admission?: MutableDaemonConfig["admission"];
  refocus?: MutableDaemonConfig["refocus"];
  remediation?: MutableDaemonConfig["remediation"];
  diskSweeper?: MutableDaemonConfig["diskSweeper"];
  // Unlike diskSweeper/tokenBurnMonitor, config and patch differ here: a per-server patch
  // entry doesn't require `url`/`transport` (see MutableMcpGatewayServerPatchSchema), so this
  // must reference the patch-shaped type, not MutableDaemonConfig's full-config shape.
  mcpGateway?: MutableDaemonConfigPatch["mcpGateway"];
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: MutableDaemonConfig["terminalProfiles"];
  agentProfiles?: MutableDaemonConfig["agentProfiles"];
  skills?: MutableDaemonConfig["skills"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
  // Opaque plugin-owned config (see persisted-config.ts). Not part of the
  // typed wire shape — MutableDaemonConfigPatchSchema is `.passthrough()`,
  // so this is read/forwarded structurally rather than narrowed further.
  agentModelPolicy?: Record<string, unknown>;
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

export interface DaemonConfigReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export interface DaemonConfigReloadSource {
  resolve(persisted: PersistedConfig): {
    mutable: MutableDaemonConfig;
    overrideControlledPaths: readonly string[];
  };
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type ConfigApplyRollback = () => void;
type ConfigApplyListener = (
  config: MutableDaemonConfig,
  previous: MutableDaemonConfig,
  details: DaemonConfigChangeDetails,
) => ConfigApplyRollback;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

function omitMetadataGenerationProvidersFromConfig<
  T extends { metadataGeneration?: { providers?: Array<{ provider?: unknown }> } },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0 || !config.metadataGeneration?.providers) {
    return config;
  }

  const removedProviderIds = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter((entry) => {
    return typeof entry.provider !== "string" || !removedProviderIds.has(entry.provider);
  });
  if (nextProviders.length === config.metadataGeneration.providers.length) {
    return config;
  }

  return {
    ...config,
    metadataGeneration: {
      ...config.metadataGeneration,
      providers: nextProviders,
    },
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const RELOADABLE_PATHS = [
  "daemon.relay.enabled",
  "daemon.mcp.enabled",
  "daemon.mcp.injectIntoAgents",
  "daemon.browserTools.enabled",
  "daemon.hostnames",
  "daemon.cors.allowedOrigins",
  "daemon.trustedProxies",
  "daemon.git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks",
  "daemon.appendSystemPrompt",
  "daemon.terminalProfiles",
  "daemon.agentProfiles",
  "app.baseUrl",
  "agents.providers",
  "agents.catalogRefreshTimeoutMs",
  "agents.metadataGeneration",
  "agents.tokenBurnMonitor",
  "agents.resourceMonitor",
  "agents.processPriority",
  "agents.deviceLeases",
  "agents.artifactJanitor",
  "agents.accountFailover",
  "agents.budgetPacing",
  "agents.leaderCompaction",
  "agents.doneJanitor",
  "agents.admission",
  "agents.refocus",
  "agents.remediation",
  "agents.skills.selection",
  // Live, but not through the mutable config: the token audit job re-reads config.json on every
  // check, so a change never needs a restart. It has no PERSISTED_TO_MUTABLE_PATH entry on
  // purpose; that only stops reload() from listing it as applied.
  "agents.tokenAudit",
  "worktrees.diskSweeper",
  // Deliberately NOT listed: the running McpGateway is constructed once in bootstrap.ts
  // and never observes config changes (its class doc calls live reconfiguration "wired
  // at the bootstrap layer in a later unit" — that unit doesn't exist yet). Listing it
  // here would make reload() report an mcpGateway edit as applied when the live gateway
  // never picked it up. Leave it out of RELOADABLE_PATHS — honesty over convenience —
  // until the gateway actually subscribes to config changes; PERSISTED_TO_MUTABLE_PATH
  // still maps it, so persistence and in-memory config both stay correct.
  "pluginsEnabled",
] as const;

const PERSISTED_TO_MUTABLE_PATH = new Map<string, string>([
  ["daemon.relay.enabled", "relay.enabled"],
  ["daemon.mcp.enabled", "mcp.enabled"],
  ["daemon.mcp.injectIntoAgents", "mcp.injectIntoAgents"],
  ["daemon.browserTools.enabled", "browserTools.enabled"],
  ["daemon.hostnames", "hostnames"],
  ["daemon.cors.allowedOrigins", "cors.allowedOrigins"],
  ["daemon.trustedProxies", "trustedProxies"],
  ["daemon.git.maxProcessesPerSecond", "git.maxProcessesPerSecond"],
  ["daemon.git.maxProcessConcurrency", "git.maxProcessConcurrency"],
  ["daemon.autoArchiveAfterMerge", "autoArchiveAfterMerge"],
  ["daemon.enableTerminalAgentHooks", "enableTerminalAgentHooks"],
  ["daemon.appendSystemPrompt", "appendSystemPrompt"],
  ["daemon.terminalProfiles", "terminalProfiles"],
  ["daemon.agentProfiles", "agentProfiles"],
  ["app.baseUrl", "app.baseUrl"],
  ["agents.providers", "providers"],
  ["agents.catalogRefreshTimeoutMs", "catalogRefreshTimeoutMs"],
  ["agents.metadataGeneration", "metadataGeneration"],
  ["agents.tokenBurnMonitor", "tokenBurnMonitor"],
  ["agents.resourceMonitor", "resourceMonitor"],
  ["agents.processPriority", "processPriority"],
  ["agents.deviceLeases", "deviceLeases"],
  ["agents.artifactJanitor", "artifactJanitor"],
  ["agents.accountFailover", "accountFailover"],
  ["agents.budgetPacing", "budgetPacing"],
  ["agents.leaderCompaction", "leaderCompaction"],
  ["agents.doneJanitor", "doneJanitor"],
  ["agents.admission", "admission"],
  ["agents.refocus", "refocus"],
  ["agents.remediation", "remediation"],
  ["agents.skills.selection", "skills.selection"],
  ["worktrees.diskSweeper", "diskSweeper"],
  ["mcpGateway", "mcpGateway"],
  ["pluginsEnabled", "pluginsEnabled"],
]);

function pathBelongsTo(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}.`);
}

function diffPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isEqualValue(previous, next)) return [];
  if (!isRecord(previous) || !isRecord(next)) {
    if (isRecord(previous)) return leafPaths(previous, prefix);
    if (isRecord(next)) return leafPaths(next, prefix);
    return prefix ? [prefix] : [];
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return diffPaths(previous[key], next[key], path);
  });
}

function leafPaths(record: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? leafPaths(value, path) : [path];
  });
}

function compactOwnedPaths(paths: readonly string[], owners: readonly string[]): string[] {
  const compacted = new Set<string>();
  for (const path of paths) {
    const owner = owners.find((candidate) => pathBelongsTo(path, candidate));
    compacted.add(owner ?? path);
  }
  return Array.from(compacted).sort();
}

function pickMetadataGenerationPatch(
  metadataGeneration: MutableDaemonConfigPatch["metadataGeneration"],
): Pick<SupportedMutableConfigPatch, "metadataGeneration"> {
  if (
    metadataGeneration?.providers === undefined &&
    metadataGeneration?.titleTracking === undefined &&
    metadataGeneration?.workspaceTitleTracking === undefined
  ) {
    return {};
  }
  return {
    metadataGeneration: {
      ...(metadataGeneration.providers !== undefined
        ? { providers: metadataGeneration.providers }
        : {}),
      ...(metadataGeneration.titleTracking !== undefined
        ? { titleTracking: metadataGeneration.titleTracking }
        : {}),
      ...(metadataGeneration.workspaceTitleTracking !== undefined
        ? { workspaceTitleTracking: metadataGeneration.workspaceTitleTracking }
        : {}),
    },
  };
}

function pickTokenBurnMonitorPatch(
  tokenBurnMonitor: MutableDaemonConfigPatch["tokenBurnMonitor"],
): Pick<SupportedMutableConfigPatch, "tokenBurnMonitor"> {
  return tokenBurnMonitor === undefined ? {} : { tokenBurnMonitor };
}

function pickResourceMonitorPatch(
  resourceMonitor: MutableDaemonConfigPatch["resourceMonitor"],
): Pick<SupportedMutableConfigPatch, "resourceMonitor"> {
  return resourceMonitor === undefined ? {} : { resourceMonitor };
}

function pickProcessPriorityPatch(
  processPriority: MutableDaemonConfigPatch["processPriority"],
): Pick<SupportedMutableConfigPatch, "processPriority"> {
  return processPriority === undefined ? {} : { processPriority };
}

function pickDeviceLeasesPatch(
  deviceLeases: MutableDaemonConfigPatch["deviceLeases"],
): Pick<SupportedMutableConfigPatch, "deviceLeases"> {
  return deviceLeases === undefined ? {} : { deviceLeases };
}

function pickArtifactJanitorPatch(
  artifactJanitor: MutableDaemonConfigPatch["artifactJanitor"],
): Pick<SupportedMutableConfigPatch, "artifactJanitor"> {
  return artifactJanitor === undefined ? {} : { artifactJanitor };
}

function pickAccountFailoverPatch(
  accountFailover: MutableDaemonConfigPatch["accountFailover"],
): Pick<SupportedMutableConfigPatch, "accountFailover"> {
  return accountFailover === undefined ? {} : { accountFailover };
}

function pickBudgetPacingPatch(
  budgetPacing: MutableDaemonConfigPatch["budgetPacing"],
): Pick<SupportedMutableConfigPatch, "budgetPacing"> {
  return budgetPacing === undefined ? {} : { budgetPacing };
}

function pickLeaderCompactionPatch(
  leaderCompaction: MutableDaemonConfigPatch["leaderCompaction"],
): Pick<SupportedMutableConfigPatch, "leaderCompaction"> {
  return leaderCompaction === undefined ? {} : { leaderCompaction };
}

function pickDoneJanitorPatch(
  doneJanitor: MutableDaemonConfigPatch["doneJanitor"],
): Pick<SupportedMutableConfigPatch, "doneJanitor"> {
  return doneJanitor === undefined ? {} : { doneJanitor };
}

function pickAdmissionPatch(
  admission: MutableDaemonConfigPatch["admission"],
): Pick<SupportedMutableConfigPatch, "admission"> {
  return admission === undefined ? {} : { admission };
}

function pickRefocusPatch(
  refocus: MutableDaemonConfigPatch["refocus"],
): Pick<SupportedMutableConfigPatch, "refocus"> {
  return refocus === undefined ? {} : { refocus };
}

function pickRemediationPatch(
  remediation: MutableDaemonConfigPatch["remediation"],
): Pick<SupportedMutableConfigPatch, "remediation"> {
  return remediation === undefined ? {} : { remediation };
}

function pickDiskSweeperPatch(
  diskSweeper: MutableDaemonConfigPatch["diskSweeper"],
): Pick<SupportedMutableConfigPatch, "diskSweeper"> {
  return diskSweeper === undefined ? {} : { diskSweeper };
}

function pickMcpGatewayPatch(
  mcpGateway: MutableDaemonConfigPatch["mcpGateway"],
): Pick<SupportedMutableConfigPatch, "mcpGateway"> {
  return mcpGateway === undefined ? {} : { mcpGateway };
}

function pickSupportedPatchFields(patch: MutableDaemonConfigPatch): SupportedMutableConfigPatch {
  return {
    ...(patch.relay?.enabled !== undefined ? { relay: { enabled: patch.relay.enabled } } : {}),
    ...(patch.mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: patch.mcp.injectIntoAgents } }
      : {}),
    ...(patch.browserTools?.enabled !== undefined
      ? { browserTools: { enabled: patch.browserTools.enabled } }
      : {}),
    ...(patch.providers !== undefined ? { providers: patch.providers } : {}),
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...pickMetadataGenerationPatch(patch.metadataGeneration),
    ...pickTokenBurnMonitorPatch(patch.tokenBurnMonitor),
    ...pickResourceMonitorPatch(patch.resourceMonitor),
    ...pickProcessPriorityPatch(patch.processPriority),
    ...pickDeviceLeasesPatch(patch.deviceLeases),
    ...pickArtifactJanitorPatch(patch.artifactJanitor),
    ...pickAccountFailoverPatch(patch.accountFailover),
    ...pickBudgetPacingPatch(patch.budgetPacing),
    ...pickLeaderCompactionPatch(patch.leaderCompaction),
    ...pickDoneJanitorPatch(patch.doneJanitor),
    ...pickAdmissionPatch(patch.admission),
    ...pickRefocusPatch(patch.refocus),
    ...pickRemediationPatch(patch.remediation),
    ...pickDiskSweeperPatch(patch.diskSweeper),
    ...pickMcpGatewayPatch(patch.mcpGateway),
    ...(patch.autoArchiveAfterMerge !== undefined
      ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge }
      : {}),
    ...(patch.enableTerminalAgentHooks !== undefined
      ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks }
      : {}),
    ...(patch.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: patch.appendSystemPrompt }
      : {}),
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(patch.agentModelPolicy !== undefined
      ? { agentModelPolicy: patch.agentModelPolicy as Record<string, unknown> }
      : {}),
  };
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? {
            paseoTools: {
              ...previousOverride?.paseoTools,
              ...parsedOverride.paseoTools,
            },
          }
        : {}),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly applyListeners = new Set<ConfigApplyListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();
  private readonly relayEnabledMutable: boolean;
  private readonly reloadSource: DaemonConfigReloadSource | undefined;
  private readonly startupPersisted: PersistedConfig;
  private lastKnownPersisted: PersistedConfig;

  constructor(
    paseoHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    options: {
      relayEnabledMutable?: boolean;
      reloadSource?: DaemonConfigReloadSource;
      startupPersisted?: PersistedConfig;
    } = {},
  ) {
    this.paseoHome = paseoHome;
    this.logger = getLogger(logger);
    const startupPersisted =
      options.startupPersisted ?? loadPersistedConfig(paseoHome, this.logger);
    this.current = MutableDaemonConfigSchema.parse({
      ...initial,
      relay: initial.relay ?? { enabled: true },
      // Opaque plugin-owned config (persisted-config.ts) isn't threaded
      // through the caller-supplied `initial` config the way built-in
      // fields are (bootstrap.ts's createInitialMutableDaemonConfig has no
      // notion of it) — lift it straight from the on-disk file so a plugin's
      // config.patch() from a previous process survives a daemon restart.
      ...(startupPersisted.agentModelPolicy !== undefined
        ? { agentModelPolicy: startupPersisted.agentModelPolicy }
        : {}),
    });
    this.relayEnabledMutable = options.relayEnabledMutable ?? true;
    this.reloadSource = options.reloadSource;
    this.startupPersisted = startupPersisted;
    this.lastKnownPersisted = startupPersisted;
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    const parsedPatch = pickSupportedPatchFields(MutableDaemonConfigPatchSchema.parse(partial));
    return this.applySupportedPatch(parsedPatch);
  }

  public setAgentSkillSelection(selection: AgentSkillSelection): MutableDaemonConfig {
    return this.applySupportedPatch({ skills: { selection } });
  }

  private applySupportedPatch(parsedPatch: SupportedMutableConfigPatch): MutableDaemonConfig {
    if (parsedPatch.relay?.enabled !== undefined && !this.relayEnabledMutable) {
      throw new Error(
        "Relay is controlled by a daemon launch override. Remove PASEO_RELAY_ENABLED or the relay CLI flag before changing it here.",
      );
    }
    const { removeProviders = [], ...configPatch } = parsedPatch;
    const removedProviders = Array.from(new Set(removeProviders));
    const merged = deepMerge(this.current, configPatch);
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitMetadataGenerationProvidersFromConfig(
        omitProvidersFromConfig(merged, removedProviders),
        removedProviders,
      ),
    );

    const configChanged = !isEqualValue(this.current, next);

    if (!configChanged && removedProviders.length === 0) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = this.persistConfig(
      configPatch,
      removedProviders,
    );
    if (!configChanged) {
      this.lastKnownPersisted = knownNext;
      return this.current;
    }

    try {
      this.applyReplacement(next, { removedProviders });
      this.lastKnownPersisted = knownNext;
    } catch (error) {
      savePersistedConfig(this.paseoHome, persistedBeforePatch, this.logger);
      throw error;
    }

    return this.current;
  }

  // agentModelPolicy is opaque plugin-owned config (persisted-config.ts) that
  // reloadSource.resolve()/createInitialMutableDaemonConfig has no notion of
  // (same gap the constructor's startup lift, above, works around), so it's
  // never present on resolved.mutable. Reload's job is to pick up disk
  // edits, so prefer the freshly-read persisted value when the file has the
  // key; fall back to carrying the in-memory value forward (like `plugins`,
  // in reload() below) only when the disk file has no key at all, so an
  // unrelated reload doesn't wipe a plugin's runtime patch() that hasn't
  // been written back to this exact file.
  private resolveReloadedAgentModelPolicy(
    persisted: PersistedConfig,
  ): { agentModelPolicy: Record<string, unknown> } | Record<string, never> {
    if (persisted.agentModelPolicy !== undefined) {
      return { agentModelPolicy: persisted.agentModelPolicy };
    }
    const current = (this.current as unknown as { agentModelPolicy?: Record<string, unknown> })
      .agentModelPolicy;
    return current !== undefined ? { agentModelPolicy: current } : {};
  }

  public reload(): DaemonConfigReloadResult {
    if (!this.reloadSource) {
      throw new Error("Daemon config reload is unavailable for this daemon instance");
    }

    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...resolved.mutable,
      plugins: this.current.plugins,
      ...this.resolveReloadedAgentModelPolicy(persisted),
    });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH.get(persistedPath);
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
  }

  private applyReplacement(
    next: MutableDaemonConfig,
    changeDetails: DaemonConfigChangeDetails,
  ): void {
    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    if (isEqualValue(this.current, next) && changeDetails.removedProviders.length === 0) return;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    const applyRollbacks: ConfigApplyRollback[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
      for (const listener of this.applyListeners) {
        applyRollbacks.push(listener(next, previous, changeDetails));
      }
    } catch (error) {
      this.current = previous;
      const rollbackErrors: unknown[] = [];
      for (const rollback of applyRollbacks.toReversed()) {
        try {
          rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const change of appliedFieldChanges.toReversed()) {
        try {
          change.handler(change.previousValue);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const rollbackFailure = new Error(
          "Daemon config apply failed and one or more live owners could not roll back",
          { cause: error },
        );
        Object.assign(rollbackFailure, { rollbackErrors });
        throw rollbackFailure;
      }
      throw error;
    }

    for (const listener of this.changeListeners) {
      try {
        listener(next, changeDetails);
      } catch (error) {
        this.logger?.info({ error }, "Daemon config change notification failed");
      }
    }
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public onApply(listener: ConfigApplyListener): () => void {
    // A live owner must either throw before changing its state or return a
    // rollback that restores the previous config. Notifications belong in
    // onChange so they run only after every live owner commits.
    this.applyListeners.add(listener);
    return () => {
      this.applyListeners.delete(listener);
    };
  }

  private persistConfig(
    patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
    removeProviders: readonly string[],
  ): { previous: PersistedConfig; knownNext: PersistedConfig } {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const merge = (source: PersistedConfig) =>
      mergeMutablePatchIntoPersistedConfig({
        persisted: source,
        patch,
        removeProviders,
        persistRelayEnabled: this.relayEnabledMutable,
      });
    const nextPersisted = merge(persisted);
    const knownNext = merge(this.lastKnownPersisted);
    savePersistedConfig(this.paseoHome, nextPersisted, this.logger);
    return { previous: persisted, knownNext };
  }
}

function mergeMutablePatchIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">;
  removeProviders: readonly string[];
  persistRelayEnabled: boolean;
}): PersistedConfig {
  const { persisted, patch, removeProviders, persistRelayEnabled } = params;
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  const worktrees = mergeMutableWorktreesPatch(persisted.worktrees, patch);
  const mcpGateway = mergeMcpGatewayForPersist(persisted.mcpGateway, patch.mcpGateway);
  return {
    ...persisted,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(patch.agentModelPolicy !== undefined ? { agentModelPolicy: patch.agentModelPolicy } : {}),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
    ...(worktrees ? { worktrees } : { worktrees: undefined }),
    ...(mcpGateway !== undefined ? { mcpGateway } : {}),
  } as PersistedConfig;
}

type PersistedMetadataGeneration = NonNullable<PersistedConfig["agents"]>["metadataGeneration"];

function mergeMetadataGenerationForPersist(
  persisted: PersistedMetadataGeneration,
  patch: SupportedMutableConfigPatch["metadataGeneration"],
  removeProviders: readonly string[],
): PersistedMetadataGeneration {
  let providers = persisted?.providers;
  if (patch?.providers !== undefined) {
    providers = patch.providers;
  } else if (removeProviders.length > 0 && providers) {
    const removed = new Set(removeProviders);
    providers = providers.filter((entry) => !removed.has(entry.provider));
  }
  const titleTracking =
    patch?.titleTracking !== undefined ? patch.titleTracking : persisted?.titleTracking;
  const workspaceTitleTracking =
    patch?.workspaceTitleTracking !== undefined
      ? patch.workspaceTitleTracking
      : persisted?.workspaceTitleTracking;

  if (
    providers === undefined &&
    titleTracking === undefined &&
    workspaceTitleTracking === undefined
  ) {
    return undefined;
  }
  return {
    ...(providers !== undefined ? { providers } : {}),
    ...(titleTracking !== undefined ? { titleTracking } : {}),
    ...(workspaceTitleTracking !== undefined ? { workspaceTitleTracking } : {}),
  };
}

type PersistedTokenBurnMonitor = NonNullable<PersistedConfig["agents"]>["tokenBurnMonitor"];

function mergeTokenBurnMonitorForPersist(
  persisted: PersistedTokenBurnMonitor,
  patch: SupportedMutableConfigPatch["tokenBurnMonitor"],
): PersistedTokenBurnMonitor {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedResourceMonitor = NonNullable<PersistedConfig["agents"]>["resourceMonitor"];

// Deep, unlike its flat siblings, and for the same reason as mergeMcpGatewayForPersist below:
// `reaper` is a nested object, so a `{ reaper: { dryRun: false } }` patch has to keep the rest
// of the reaper's settings on disk — exactly what the live `this.current` deepMerge does.
function mergeResourceMonitorForPersist(
  persisted: PersistedResourceMonitor,
  patch: SupportedMutableConfigPatch["resourceMonitor"],
): PersistedResourceMonitor {
  if (patch === undefined) {
    return persisted;
  }
  return deepMerge(
    (persisted ?? {}) as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as PersistedResourceMonitor;
}

type PersistedProcessPriority = NonNullable<PersistedConfig["agents"]>["processPriority"];

// Flat like deviceLeases below: every key is a scalar, so a shallow merge keeps the rest.
function mergeProcessPriorityForPersist(
  persisted: PersistedProcessPriority,
  patch: SupportedMutableConfigPatch["processPriority"],
): PersistedProcessPriority {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedDeviceLeases = NonNullable<PersistedConfig["agents"]>["deviceLeases"];

// Flat, unlike resourceMonitor above: every key is a scalar, so a shallow merge keeps the rest
// of the block on disk.
function mergeDeviceLeasesForPersist(
  persisted: PersistedDeviceLeases,
  patch: SupportedMutableConfigPatch["deviceLeases"],
): PersistedDeviceLeases {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedBudgetPacing = NonNullable<PersistedConfig["agents"]>["budgetPacing"];

// Deep, like resourceMonitor above: `speedUp`/`slowDown` are nested objects, so a patch that
// touches one threshold has to keep the rest of that direction's settings on disk.
function mergeBudgetPacingForPersist(
  persisted: PersistedBudgetPacing,
  patch: SupportedMutableConfigPatch["budgetPacing"],
): PersistedBudgetPacing {
  if (patch === undefined) {
    return persisted;
  }
  return deepMerge(
    (persisted ?? {}) as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as PersistedBudgetPacing;
}

type PersistedLeaderCompaction = NonNullable<PersistedConfig["agents"]>["leaderCompaction"];

// Flat, like deviceLeases: no nested block for a shallow spread to drop.
function mergeLeaderCompactionForPersist(
  persisted: PersistedLeaderCompaction,
  patch: SupportedMutableConfigPatch["leaderCompaction"],
): PersistedLeaderCompaction {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch } as PersistedLeaderCompaction;
}

type PersistedArtifactJanitor = NonNullable<PersistedConfig["agents"]>["artifactJanitor"];

// `diskGuard` is a nested block, so a shallow spread would drop the rest of it when a patch
// names one of its keys — deepMerge, like resourceMonitor's `reaper`, not deviceLeases' flat one.
function mergeArtifactJanitorForPersist(
  persisted: PersistedArtifactJanitor,
  patch: SupportedMutableConfigPatch["artifactJanitor"],
): PersistedArtifactJanitor {
  if (patch === undefined) {
    return persisted;
  }
  return deepMerge(
    (persisted ?? {}) as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as PersistedArtifactJanitor;
}

type PersistedAccountFailover = NonNullable<PersistedConfig["agents"]>["accountFailover"];

function mergeAccountFailoverForPersist(
  persisted: PersistedAccountFailover,
  patch: SupportedMutableConfigPatch["accountFailover"],
): PersistedAccountFailover {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedDoneJanitor = NonNullable<PersistedConfig["agents"]>["doneJanitor"];

function mergeDoneJanitorForPersist(
  persisted: PersistedDoneJanitor,
  patch: SupportedMutableConfigPatch["doneJanitor"],
): PersistedDoneJanitor {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedAdmission = NonNullable<PersistedConfig["agents"]>["admission"];

// Flat, like doneJanitor above: every key is a scalar.
function mergeAdmissionForPersist(
  persisted: PersistedAdmission,
  patch: SupportedMutableConfigPatch["admission"],
): PersistedAdmission {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch } as PersistedAdmission;
}

type PersistedRemediation = NonNullable<PersistedConfig["agents"]>["remediation"];

// Deep, like resourceMonitor: every rung and sweep is a nested block, so a
// `{ escalation: { enabled: false } }` patch has to keep the rest of the ladder on disk.
function mergeRemediationForPersist(
  persisted: PersistedRemediation,
  patch: SupportedMutableConfigPatch["remediation"],
): PersistedRemediation {
  if (patch === undefined) {
    return persisted;
  }
  return deepMerge(
    (persisted ?? {}) as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as PersistedRemediation;
}

type PersistedRefocus = NonNullable<PersistedConfig["agents"]>["refocus"];

function mergeRefocusForPersist(
  persisted: PersistedRefocus,
  patch: SupportedMutableConfigPatch["refocus"],
): PersistedRefocus {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch } as PersistedRefocus;
}

type PersistedDiskSweeper = NonNullable<PersistedConfig["worktrees"]>["diskSweeper"];

function mergeDiskSweeperForPersist(
  persisted: PersistedDiskSweeper,
  patch: SupportedMutableConfigPatch["diskSweeper"],
): PersistedDiskSweeper {
  if (patch === undefined) {
    return persisted;
  }
  return { ...persisted, ...patch };
}

type PersistedMcpGateway = PersistedConfig["mcpGateway"];

// Reuses the same `deepMerge` as the live `this.current` merge (rather than a bespoke
// shallow merge) so a partial patch — e.g. `{ servers: { zeeq: { critical: false } } }` —
// merges per-server-field identically on disk and in memory instead of the persisted file
// wholesale-replacing `servers` while the live config only updates the one named field.
function mergeMcpGatewayForPersist(
  persisted: PersistedMcpGateway,
  patch: SupportedMutableConfigPatch["mcpGateway"],
): PersistedMcpGateway {
  if (patch === undefined) {
    return persisted;
  }
  return deepMerge(
    (persisted ?? {}) as Record<string, unknown>,
    patch as Record<string, unknown>,
  ) as PersistedMcpGateway;
}

function mergeMutableWorktreesPatch(
  persistedWorktrees: PersistedConfig["worktrees"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
): PersistedConfig["worktrees"] {
  if (patch.diskSweeper === undefined) {
    return persistedWorktrees;
  }

  const next = { ...persistedWorktrees } as NonNullable<PersistedConfig["worktrees"]>;
  const diskSweeper = mergeDiskSweeperForPersist(
    persistedWorktrees?.diskSweeper,
    patch.diskSweeper,
  );
  if (diskSweeper !== undefined) next.diskSweeper = diskSweeper;
  return Object.keys(next).length > 0 ? next : undefined;
}

function touchesAgentConfig(
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): boolean {
  return (
    patch.providers !== undefined ||
    patch.metadataGeneration !== undefined ||
    patch.tokenBurnMonitor !== undefined ||
    patch.resourceMonitor !== undefined ||
    patch.processPriority !== undefined ||
    patch.deviceLeases !== undefined ||
    patch.artifactJanitor !== undefined ||
    patch.accountFailover !== undefined ||
    patch.budgetPacing !== undefined ||
    patch.leaderCompaction !== undefined ||
    patch.doneJanitor !== undefined ||
    patch.admission !== undefined ||
    patch.refocus !== undefined ||
    patch.remediation !== undefined ||
    patch.skills !== undefined ||
    removeProviders.length > 0
  );
}

// The agents.* sections that limit how the daemon treats agent processes rather than monitor
// them. Split from mergeMonitorSectionsForPersist to keep it under the complexity limit.
function mergeProcessPolicySectionsForPersist(
  next: Record<string, unknown>,
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
): void {
  const processPriority = mergeProcessPriorityForPersist(
    persistedAgents?.processPriority,
    patch.processPriority,
  );
  if (processPriority !== undefined) next["processPriority"] = processPriority;
  const admission = mergeAdmissionForPersist(persistedAgents?.admission, patch.admission);
  if (admission !== undefined) next["admission"] = admission;
}

// The agents.* monitor sections, one merge each. Split out of mergeMutableAgentPatch so a new
// monitor costs this list a line rather than that function another branch.
function mergeMonitorSectionsForPersist(
  next: Record<string, unknown>,
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
): void {
  // Read once, so each section costs one branch here rather than two.
  const persisted: NonNullable<PersistedConfig["agents"]> = persistedAgents ?? {};
  const tokenBurnMonitor = mergeTokenBurnMonitorForPersist(
    persisted.tokenBurnMonitor,
    patch.tokenBurnMonitor,
  );
  if (tokenBurnMonitor !== undefined) next["tokenBurnMonitor"] = tokenBurnMonitor;

  const resourceMonitor = mergeResourceMonitorForPersist(
    persisted.resourceMonitor,
    patch.resourceMonitor,
  );
  if (resourceMonitor !== undefined) next["resourceMonitor"] = resourceMonitor;

  const deviceLeases = mergeDeviceLeasesForPersist(persisted.deviceLeases, patch.deviceLeases);
  if (deviceLeases !== undefined) next["deviceLeases"] = deviceLeases;

  const artifactJanitor = mergeArtifactJanitorForPersist(
    persisted.artifactJanitor,
    patch.artifactJanitor,
  );
  if (artifactJanitor !== undefined) next["artifactJanitor"] = artifactJanitor;

  const accountFailover = mergeAccountFailoverForPersist(
    persisted.accountFailover,
    patch.accountFailover,
  );
  if (accountFailover !== undefined) next["accountFailover"] = accountFailover;

  const budgetPacing = mergeBudgetPacingForPersist(persisted.budgetPacing, patch.budgetPacing);
  if (budgetPacing !== undefined) next["budgetPacing"] = budgetPacing;

  const leaderCompaction = mergeLeaderCompactionForPersist(
    persisted.leaderCompaction,
    patch.leaderCompaction,
  );
  if (leaderCompaction !== undefined) next["leaderCompaction"] = leaderCompaction;

  const doneJanitor = mergeDoneJanitorForPersist(persisted.doneJanitor, patch.doneJanitor);
  if (doneJanitor !== undefined) next["doneJanitor"] = doneJanitor;

  const refocus = mergeRefocusForPersist(persisted.refocus, patch.refocus);
  if (refocus !== undefined) next["refocus"] = refocus;

  const remediation = mergeRemediationForPersist(persisted.remediation, patch.remediation);
  if (remediation !== undefined) next["remediation"] = remediation;
}

function mergeMutableAgentPatch(
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): PersistedConfig["agents"] {
  if (!touchesAgentConfig(patch, removeProviders)) {
    return persistedAgents;
  }

  const next = { ...persistedAgents } as Record<string, unknown>;
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persistedAgents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persistedProviderOverrides,
    patch.providers,
  );
  if (providerOverrides) next["providers"] = providerOverrides;
  else delete next["providers"];

  const metadataGeneration = mergeMetadataGenerationForPersist(
    persistedAgents?.metadataGeneration,
    patch.metadataGeneration,
    removeProviders,
  );
  if (metadataGeneration !== undefined) next["metadataGeneration"] = metadataGeneration;

  mergeMonitorSectionsForPersist(next, persistedAgents, patch);
  mergeProcessPolicySectionsForPersist(next, persistedAgents, patch);

  if (patch.skills?.selection !== undefined) {
    next["skills"] = { selection: patch.skills.selection };
  }

  return Object.keys(next).length > 0 ? (next as PersistedConfig["agents"]) : undefined;
}

function mergeMutableDaemonPatch(
  persistedDaemon: PersistedConfig["daemon"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  persistRelayEnabled: boolean,
): PersistedConfig["daemon"] {
  const next = { ...persistedDaemon } as NonNullable<PersistedConfig["daemon"]>;
  if (persistRelayEnabled && patch.relay?.enabled !== undefined) {
    next.relay = { ...next.relay, enabled: patch.relay.enabled };
  }
  if (patch.mcp?.injectIntoAgents !== undefined) {
    next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  }
  if (patch.browserTools?.enabled !== undefined) {
    next.browserTools = { ...next.browserTools, enabled: patch.browserTools.enabled };
  }
  if (patch.autoArchiveAfterMerge !== undefined) {
    next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  }
  if (patch.enableTerminalAgentHooks !== undefined) {
    next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  }
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  return Object.keys(next).length > 0 ? next : undefined;
}
