import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  AgentProviderRuntimeSettingsMapSchema,
  migrateProviderSettings,
  ProviderOverridesSchema,
} from "./agent/provider-launch-config.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";
import {
  AgentProfileSchema,
  AgentSkillSelectionSchema,
  PluginIdSchema,
  PluginSourceSchema,
  TerminalProfileSchema,
} from "@getpaseo/protocol/messages";
import { PaseoServicePortAllocationSchema } from "@getpaseo/protocol/paseo-config-schema";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const LogFormatSchema = z.enum(["pretty", "json"]);

const LogConfigSchema = z
  .object({
    // Legacy global log settings (kept for backwards compatibility).
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),

    console: z
      .object({
        level: LogLevelSchema.optional(),
        format: LogFormatSchema.optional(),
      })
      .strict()
      .optional(),

    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OpenAiSpeechEndpointSchema = z
  .object({
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict();

const OpenAiProviderSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    stt: OpenAiSpeechEndpointSchema.optional(),
    tts: OpenAiSpeechEndpointSchema.optional(),
  })
  .strict();

const LocalSpeechProviderSchema = z
  .object({
    modelsDir: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
    openai: OpenAiProviderSchema.optional(),
    local: LocalSpeechProviderSchema.optional(),
  })
  .strict();

// Live-toggleable like agents.tokenBurnMonitor (66f76986a) — same mutable/patch split for the
// same reason: `.partial()` on the config schema would make an absent field indistinguishable
// from an explicit reset. See docs/plans/2026-09-12-007-feat-disk-sweeper-indicator-plan.md.
const DiskSweeperConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    sweepIntervalMs: z.number().positive().optional(),
    retentionDays: z.number().positive().optional(),
    maxDeletionsPerTick: z.number().int().positive().optional(),
    minFreeGB: z.number().positive().optional(),
    sampleTimeoutMs: z.number().positive().optional(),
  })
  .strict();

const WorktreesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    servicePorts: PaseoServicePortAllocationSchema.optional(),
    diskSweeper: DiskSweeperConfigSchema.optional(),
  })
  .strict();

const McpGatewayServerConfigSchema = z
  .object({
    url: z.string().min(1),
    transport: z.enum(["http", "sse"]),
    critical: z.boolean().optional(),
    auth: z.enum(["oauth", "static"]).optional(),
  })
  .strict();

// docs/mcp-gateway.md "Local servers": a stdio server the daemon runs and brokers itself.
const McpGatewayLocalServerConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    critical: z.boolean().optional(),
    auth: z.literal("static").optional(),
  })
  .strict();

// New top-level section (KTD9), same mutable/patch split as diskSweeper/tokenBurnMonitor —
// see the `MutableMcpGatewayConfigSchema` comment in @getpaseo/protocol/messages for why this
// isn't shared with the wire schema. Adding a server is config-only (R9): drop an entry into
// `servers` and it's picked up on reload/restart, no code change. Criticality (R11) is seeded
// here by the operator, not hardcoded — e.g. `zeeq`/`agent-gateway` marked `critical: true`.
// Static-auth header VALUES never live here — only that a server uses static auth
// (`auth: "static"`) — because `MutableDaemonConfig` is broadcast in full to every connected
// client; the value lives in the daemon's private 0600 token store, keyed by server name
// (mcp-gateway/token-store.ts).
const McpGatewayConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    // docs/mcp-gateway.md "Session injection": overlay (default) or strict.
    sessionMode: z.enum(["overlay", "strict"]).optional(),
    servers: z.record(z.string(), McpGatewayServerConfigSchema).optional(),
    localServers: z.record(z.string(), McpGatewayLocalServerConfigSchema).optional(),
  })
  .strict();

const BcryptHashSchema = z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, {
  message: "Expected a bcrypt hash",
});

const DaemonAuthSchema = z
  .object({
    password: BcryptHashSchema.optional(),
  })
  .strict();

const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));

const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureVoiceModeSchema = z
  .object({
    enabled: z.boolean().optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    turnDetection: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
        speakerId: z.number().int().optional(),
        speed: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureWebUiSchema = z
  .object({
    enabled: z.boolean().optional(),
    distDir: z.string().min(1).optional(),
  })
  .strict();

const StructuredGenerationProviderConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const AgentMetadataGenerationSchema = z
  .object({
    providers: z.array(StructuredGenerationProviderConfigSchema).optional(),
    titleTracking: z
      .object({
        enabled: z.boolean().optional(),
        refreshIntervalMinutes: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Each ladder stage of the spend governor switches independently, with its own multiple of the
// task's budget. See agent/spend-governor.ts and docs/token-burn.md.
const SpendGovernorStageSchema = z
  .object({
    enabled: z.boolean().optional(),
    atFraction: z.number().positive().optional(),
  })
  .strict();

const AgentTokenBurnMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
    ratePerMinute: z.number().positive().optional(),
    sustainedMinutes: z.number().positive().optional(),
    totalTokens: z.number().positive().optional(),
    scope: z.enum(["all", "topLevelOnly"]).optional(),
    breachBatchThreshold: z.number().int().positive().optional(),
    // Opt-in enforcement ladder. Off unless this says otherwise, and `dryRun` reports the whole
    // ladder without performing any of it.
    governor: z
      .object({
        enabled: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        // Nullable on purpose: null (the default) means an agent whose task declared no
        // `paseo.budget` label is not governed at all.
        defaultBudgetTokens: z.number().positive().nullable().optional(),
        downgradeToModel: z.string().min(1).nullable().optional(),
        notify: SpendGovernorStageSchema.optional(),
        downgrade: SpendGovernorStageSchema.optional(),
        stopFanOut: SpendGovernorStageSchema.optional(),
        pause: SpendGovernorStageSchema.optional(),
      })
      .strict()
      .optional(),
    // Opt-in, report-only provider usage-window leg.
    accountPressure: z
      .object({
        enabled: z.boolean().optional(),
        usedPct: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Live-toggleable like agents.tokenBurnMonitor above — same mutable/patch split, same reason.
// See docs/resource-monitor.md.
const AgentResourceMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
    memoryBytesPerAgent: z.number().positive().optional(),
    cpuPercentPerAgent: z.number().positive().optional(),
    sustainedMinutes: z.number().positive().optional(),
    systemSwapUsedRatio: z.number().positive().optional(),
    orphanBuildDaemonBytes: z.number().positive().optional(),
    notifyAgent: z.boolean().optional(),
    // Opt-in reaper leg (agent/build-daemon-reaper.ts). Off unless this says otherwise.
    reaper: z
      .object({
        enabled: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        idleCpuPercent: z.number().nonnegative().optional(),
        idleMinutes: z.number().positive().optional(),
        minIdleSweeps: z.number().int().positive().optional(),
        maxPerSweep: z.number().int().positive().optional(),
        graceMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Live-toggleable like agents.resourceMonitor above — same mutable/patch split, same reason.
// Off by default like the reaper it is modelled on. See docs/device-leases.md.
const AgentDeviceLeasesSchema = z
  .object({
    enabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    // Both caps default to what the machine can carry (agent/device-slot-defaults.ts) rather
    // than a constant, so a bigger desk gets a bigger number without editing anything.
    totalSlots: z.number().int().positive().optional(),
    slotsPerPlatform: z.number().int().positive().optional(),
    requireHeadroom: z.boolean().optional(),
    minAvailableBytes: z.number().positive().optional(),
    maxSwapUsedRatio: z.number().positive().optional(),
    pendingTtlMinutes: z.number().positive().optional(),
    // 0 disables the backstop.
    maxLeaseHours: z.number().nonnegative().optional(),
    queueTimeoutMinutes: z.number().positive().optional(),
  })
  .strict();

// Off by default like the reaper and the device cap it is modelled on, and every key optional:
// a daemon that has never heard of this block behaves exactly as it does today. Deletion is
// gated on `enabled`; the disk guard is its own opt-in because refusing a launch removes
// nothing. See docs/artifact-janitor.md.
const AgentArtifactJanitorSchema = z
  .object({
    enabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    minAgeHours: z.number().positive().optional(),
    minSweeps: z.number().int().positive().optional(),
    obligationGraceMinutes: z.number().positive().optional(),
    obligationTtlHours: z.number().positive().optional(),
    maxPerSweep: z.number().int().positive().optional(),
    maxBytesPerSweep: z.number().positive().optional(),
    diskGuard: z
      .object({
        enabled: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        minFreeBytes: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Live-toggleable like agents.tokenBurnMonitor/resourceMonitor above — same mutable/patch
// split, same reason. See docs/account-failover.md.
const AgentAccountFailoverSchema = z
  .object({
    enabled: z.boolean().optional(),
    migrateSubagents: z.boolean().optional(),
    migrationConcurrency: z.number().int().positive().optional(),
    notifyParent: z.boolean().optional(),
    // The return leg. Absent means the built-in defaults (account-failover-return.ts), which is
    // what a daemon that has never been configured runs.
    returnHome: z.boolean().optional(),
    returnMaxHomeUsedPct: z.number().nonnegative().optional(),
    returnMinIdleMinutes: z.number().nonnegative().optional(),
    returnCooldownMinutes: z.number().nonnegative().optional(),
    returnRetryBackoffMinutes: z.number().nonnegative().optional(),
    returnMaxUsageAgeMinutes: z.number().nonnegative().optional(),
  })
  .strict();

// Live-toggleable like agents.accountFailover above — same mutable/patch split, same reason.
// Every field optional and absent means today's behaviour: the leg is off unless `enabled` says
// otherwise. See docs/budget-pacing.md.
const AgentBudgetPacingSchema = z
  .object({
    enabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    paceLookbackMinutes: z.number().positive().optional(),
    minObservationMinutes: z.number().positive().optional(),
    staleUsageMinutes: z.number().positive().optional(),
    minActionableMinutes: z.number().nonnegative().optional(),
    repeatAfterMinutes: z.number().nonnegative().optional(),
    repeatWorseningPct: z.number().nonnegative().optional(),
    // 0 silences a direction for the rest of every cycle without turning the leg off.
    maxAdvisoriesPerCycle: z.number().int().nonnegative().optional(),
    speedUp: z
      .object({
        enabled: z.boolean().optional(),
        horizonMinutes: z.number().positive().optional(),
        paceRatio: z.number().positive().optional(),
        minStrandedPct: z.number().nonnegative().optional(),
        minRemainingPct: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    slowDown: z
      .object({
        enabled: z.boolean().optional(),
        paceRatio: z.number().positive().optional(),
        maxRemainingPct: z.number().nonnegative().optional(),
        minOvershootPct: z.number().nonnegative().optional(),
        minEarlyMinutes: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Off unless `enabled` says otherwise. See docs/done-janitor.md.
const AgentDoneJanitorSchema = z
  .object({
    enabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    quietHours: z.number().positive().optional(),
    maxQuestionsPerSweep: z.number().int().positive().optional(),
    maxArchivesPerSweep: z.number().int().positive().optional(),
    answerTimeoutMinutes: z.number().positive().optional(),
    reclaimWorkspaces: z.boolean().optional(),
  })
  .strict();

const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

function isLegacyProviderEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const command = (value as Record<string, unknown>).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return false;
  }

  return typeof (command as Record<string, unknown>).mode === "string";
}

function normalizeAgentProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const rawProviders = value as Record<string, unknown>;
  const hasLegacyEntries = Object.values(rawProviders).some((entry) =>
    isLegacyProviderEntry(entry),
  );
  if (!hasLegacyEntries) {
    return value;
  }

  const legacyEntries: Record<string, unknown> = {};
  const normalizedEntries: Record<string, unknown> = {};

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (isLegacyProviderEntry(providerValue)) {
      legacyEntries[providerId] = providerValue;
      continue;
    }
    normalizedEntries[providerId] = providerValue;
  }

  const parsedLegacyEntries = AgentProviderRuntimeSettingsMapSchema.safeParse(legacyEntries);
  if (!parsedLegacyEntries.success) {
    return value;
  }

  return {
    ...normalizedEntries,
    ...migrateProviderSettings(parsedLegacyEntries.data, [...BUILTIN_PROVIDER_IDS]),
  };
}

export const PersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // v1 schema marker
    version: z.literal(1).optional(),

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z.union([z.literal(true), z.array(z.string())]).optional(),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
            injectIntoAgents: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        browserTools: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        autoArchiveAfterMerge: z.boolean().optional(),
        enableTerminalAgentHooks: z.boolean().optional(),
        appendSystemPrompt: z.string().optional(),
        terminalProfiles: z.array(TerminalProfileSchema).optional(),
        agentProfiles: z.array(AgentProfileSchema).optional(),
        cors: z
          .object({
            allowedOrigins: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            publicEndpoint: z.string().optional(),
            useTls: z.boolean().optional(),
            publicUseTls: z.boolean().optional(),
          })
          .strict()
          .optional(),
        serviceProxy: z
          .object({
            // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
            // Parsed only to suppress optional public/listen layers for old configs;
            // localhost service proxying remains always enabled.
            enabled: z.boolean().optional(),
            listen: z.string().optional(),
            publicBaseUrl: z.url().optional(),
          })
          .strict()
          .optional(),
        auth: DaemonAuthSchema.optional(),
      })
      .strict()
      .transform(({ allowedHosts, ...daemon }) => {
        const hostnames = daemon.hostnames ?? allowedHosts;
        return hostnames === undefined ? daemon : { ...daemon, hostnames };
      })
      .optional(),

    app: z
      .object({
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),

    providers: ProvidersSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    // Opaque plugin-owned config (e.g. claude-account-pool's role-model
    // policy: docs/plans/2026-09-12-004-feat-agent-model-policy-plan.md
    // §2.4). The daemon persists and round-trips this verbatim; the owning
    // plugin validates its own shape and fails closed on malformed data.
    agentModelPolicy: z.record(z.string(), z.unknown()).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    mcpGateway: McpGatewayConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        catalogRefreshTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
        metadataGeneration: AgentMetadataGenerationSchema.optional(),
        tokenBurnMonitor: AgentTokenBurnMonitorSchema.optional(),
        resourceMonitor: AgentResourceMonitorSchema.optional(),
        deviceLeases: AgentDeviceLeasesSchema.optional(),
        artifactJanitor: AgentArtifactJanitorSchema.optional(),
        accountFailover: AgentAccountFailoverSchema.optional(),
        budgetPacing: AgentBudgetPacingSchema.optional(),
        doneJanitor: AgentDoneJanitorSchema.optional(),
        skills: z.object({ selection: AgentSkillSelectionSchema.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
        webUi: FeatureWebUiSchema.optional(),
      })
      .strict()
      .optional(),

    log: LogConfigSchema.optional(),
  })
  .strict();

type PersistedConfigSchemaOutput = z.infer<typeof PersistedConfigSchema>;

export type PersistedConfig = Omit<PersistedConfigSchemaOutput, "agents"> & {
  agents?: Omit<NonNullable<PersistedConfigSchemaOutput["agents"]>, "providers"> & {
    providers?: AgentProviderRuntimeSettingsMap;
  };
};

const CONFIG_FILENAME = "config.json";
const DEFAULT_PERSISTED_CONFIG = PersistedConfigSchema.parse({
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    cors: {
      allowedOrigins: ["https://app.paseo.sh"],
    },
    relay: {
      enabled: false,
    },
  },
  app: {
    baseUrl: "https://app.paseo.sh",
  },
}) as PersistedConfig;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

// Removed config fields are stripped before parsing so the strict schema does not
// reject a config written by an older release. The stripped values are discarded,
// not migrated — there is no back-compat for the removed `providers.openai.voice`
// block (use `providers.openai.stt` / `providers.openai.tts`).
function stripRemovedConfigFields(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const root = { ...(parsed as Record<string, unknown>) };
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return root;
  }

  const providersRecord = { ...(providers as Record<string, unknown>) };

  const local = providersRecord.local;
  if (local && typeof local === "object" && !Array.isArray(local)) {
    const localRecord = { ...(local as Record<string, unknown>) };
    delete localRecord.autoDownload;
    providersRecord.local = localRecord;
  }

  const openai = providersRecord.openai;
  if (openai && typeof openai === "object" && !Array.isArray(openai)) {
    const openaiRecord = { ...(openai as Record<string, unknown>) };
    // COMPAT(openaiVoiceConfig): added 2026-06-30, remove after 2026-12-30.
    // Drop a `providers.openai.voice` block left by an older release so the strict
    // schema doesn't reject it. The value is discarded, not migrated — there is no
    // back-compat; configure `providers.openai.stt` / `providers.openai.tts` instead.
    delete openaiRecord.voice;
    providersRecord.openai = openaiRecord;
  }

  root.providers = providersRecord;
  return root;
}

export function loadPersistedConfig(paseoHome: string, logger?: LoggerLike): PersistedConfig {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  if (!existsSync(configPath)) {
    try {
      writePrivateFileAtomicSync(
        configPath,
        JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
      );
      log?.info(`Initialized config file at ${configPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
    }
  }

  let raw: string;
  try {
    ensurePrivateFile(configPath);
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const migrated = stripRemovedConfigFields(parsed);
  const result = PersistedConfigSchema.safeParse(migrated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config in ${configPath}:\n${issues}`);
  }

  log?.info(`Loaded from ${configPath}`);
  return result.data as PersistedConfig;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config to save:\n${issues}`);
  }

  try {
    writePrivateFileAtomicSync(configPath, JSON.stringify(result.data, null, 2) + "\n");
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, {
      cause: err,
    });
  }
}
