import type { Logger } from "pino";
import pLimit from "p-limit";
import { buildAccountFailoverNotificationPayload } from "@getpaseo/protocol/account-failover-notification";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary, AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import {
  DEFAULT_REACTIVE_SIGNAL_TTL_MS,
  planAccountFailoverSweep,
  type LimitErrorSighting,
  type ProviderLimitSighting,
} from "./agent/account-failover-detector.js";
import {
  resolveAccountPoolEntries,
  type AccountPoolProviderEntry,
} from "./agent/account-pool-providers.js";
import {
  migrateStuckAgent,
  type AccountFailoverOutcome,
} from "./agent/account-failover-migration.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent/agent-prompt.js";
import type { PushNotificationSender } from "./push/index.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MIGRATION_CONCURRENCY = 3;

export interface AccountFailoverConfig {
  enabled?: boolean;
  migrateSubagents?: boolean;
  migrationConcurrency?: number;
  notifyParent?: boolean;
}

export interface AccountFailoverMonitorOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  providerUsage: Pick<ProviderUsageService, "listUsage">;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  /** `providers` is the daemon's resolved `agents.providers`; the pool lives in its params. */
  readDaemonConfig: () => {
    accountFailover?: AccountFailoverConfig;
    providers?: Record<string, unknown>;
  };
  logger: Logger;
  sweepIntervalMs?: number;
  reactiveSignalTtlMs?: number;
  now?: () => number;
}

interface ResolvedAccountFailoverConfig {
  migrateSubagents: boolean;
  migrationConcurrency: number;
  notifyParent: boolean;
}

function resolveConfig(config: AccountFailoverConfig | undefined): ResolvedAccountFailoverConfig {
  return {
    migrateSubagents: config?.migrateSubagents ?? true,
    migrationConcurrency: config?.migrationConcurrency ?? DEFAULT_MIGRATION_CONCURRENCY,
    notifyParent: config?.notifyParent ?? true,
  };
}

type MigratedOutcome = Extract<AccountFailoverOutcome, { kind: "migrated" }>;

/**
 * Moves agents stuck on a Claude account that ran out of budget onto a healthy pool account —
 * the claude-account-handoff procedure, run by the daemon. Same shape as AgentResourceMonitor and
 * AgentTokenBurnMonitor: an unref'd timer, config re-read every sweep (live-toggleable), no
 * persisted state of its own. Idempotency lives on agent labels (account-failover-detector.ts);
 * the only in-memory state is the reactive-signal sightings, which a restart rebuilds.
 * Independent of the account-pool routing plugin by design: it reads the pool from daemon config
 * and never calls the plugin, so it keeps working when the plugin is disconnected.
 * See docs/account-failover.md.
 */
export class AccountFailoverMonitor {
  private readonly options: AccountFailoverMonitorOptions;
  private readonly sweepIntervalMs: number;
  private readonly reactiveSignalTtlMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private sightings = new Map<string, LimitErrorSighting>();
  private providerSightings = new Map<string, ProviderLimitSighting>();

  constructor(options: AccountFailoverMonitorOptions) {
    this.options = options;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.reactiveSignalTtlMs = options.reactiveSignalTtlMs ?? DEFAULT_REACTIVE_SIGNAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Account failover sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one sweep; a call while another sweep is in flight returns without sweeping. */
  async tick(): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<void> {
    const daemonConfig = this.options.readDaemonConfig();
    if (daemonConfig.accountFailover?.enabled === false) {
      return;
    }
    const config = resolveConfig(daemonConfig.accountFailover);
    const poolEntries = resolveAccountPoolEntries(daemonConfig.providers);
    if (poolEntries.length === 0) {
      this.sightings.clear();
      this.providerSightings.clear();
      return;
    }

    const plan = planAccountFailoverSweep({
      poolProviderIds: new Set(poolEntries.map((entry) => entry.providerId)),
      agents: this.options.agentManager.listAgentsForAccountFailover(),
      usage: await this.readUsage(),
      previousSightings: this.sightings,
      previousProviderSightings: this.providerSightings,
      nowMs: this.now(),
      reactiveSignalTtlMs: this.reactiveSignalTtlMs,
      migrateSubagents: config.migrateSubagents,
    });
    this.sightings = plan.sightings;
    this.providerSightings = plan.providerSightings;
    if (plan.candidates.length === 0) {
      return;
    }

    const limit = pLimit({ concurrency: config.migrationConcurrency });
    await Promise.all(
      plan.candidates.map((agent) =>
        limit(() =>
          this.migrateOne({
            agent,
            poolEntries,
            deadProviderIds: plan.deadProviderIds,
            sighting: plan.sightings.get(agent.id),
            config,
          }),
        ),
      ),
    );
  }

  private async readUsage(): Promise<ProviderUsage[] | null> {
    try {
      return (await this.options.providerUsage.listUsage()).providers;
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Account failover: provider usage unreadable, using the reactive signal only",
      );
      return null;
    }
  }

  private async migrateOne(input: {
    agent: AccountFailoverAgentSummary;
    poolEntries: readonly AccountPoolProviderEntry[];
    deadProviderIds: ReadonlySet<string>;
    sighting: LimitErrorSighting | undefined;
    config: ResolvedAccountFailoverConfig;
  }): Promise<void> {
    const { agent, poolEntries, deadProviderIds, config } = input;
    const { logger } = this.options;
    let outcome: AccountFailoverOutcome;
    try {
      outcome = await migrateStuckAgent({
        agent,
        poolEntries,
        deadProviderIds,
        agentManager: this.options.agentManager,
        agentStorage: this.options.agentStorage,
        workspaceProvisioning: this.options.workspaceProvisioning,
        logger,
      });
    } catch (error) {
      logger.warn(
        { err: error, agentId: agent.id, provider: agent.provider },
        "Account failover: migration failed; will retry next sweep",
      );
      return;
    }

    switch (outcome.kind) {
      case "moved":
        logger.info(
          {
            agentId: outcome.agentId,
            from: outcome.oldProviderId,
            to: outcome.targetProviderId,
          },
          "Account failover: moved the agent's session to a healthy account in place",
        );
        // The agent took its failure with it when it left, so nothing on the old account still
        // reports the cap. Keep the evidence on the provider, dated by the original failure, or
        // the next sweep would read it as healthy and send the next stuck agent back onto it.
        this.providerSightings.set(outcome.oldProviderId, {
          error: agent.lastError ?? "",
          firstSeenMs: input.sighting?.firstSeenMs ?? this.now(),
        });
        await this.notifyPush({
          workspaceId: outcome.workspaceId,
          oldAgentId: outcome.agentId,
          oldTitle: outcome.title,
          newAgentId: outcome.agentId,
          targetProviderId: outcome.targetProviderId,
        });
        // No parent message: the subagent kept its id, so the parent's finish notification and
        // every existing handle to it still work.
        return;
      case "no-target":
        logger.warn(
          { agentId: agent.id, provider: agent.provider, deadProviderIds: [...deadProviderIds] },
          "Account failover: no healthy worker account; will retry next sweep",
        );
        return;
      case "adopted":
        logger.info(
          { agentId: outcome.oldAgentId, successorId: outcome.newAgentId },
          "Account failover: agent was already handed off; marked it retired",
        );
        return;
      case "migrated":
        logger.info(
          {
            agentId: outcome.oldAgentId,
            successorId: outcome.newAgentId,
            from: outcome.oldProviderId,
            to: outcome.targetProviderId,
            revived: outcome.revived,
          },
          "Account failover: moved agent to a healthy account",
        );
        if (outcome.staleError) {
          this.sightings.set(outcome.newAgentId, {
            ...outcome.staleError,
            firstSeenMs: Number.NEGATIVE_INFINITY,
          });
        }
        await this.notifyPush({
          workspaceId: outcome.workspaceId,
          oldAgentId: outcome.oldAgentId,
          oldTitle: outcome.oldTitle,
          newAgentId: outcome.newAgentId,
          targetProviderId: outcome.targetProviderId,
        });
        if (config.notifyParent) {
          await this.notifyParent(outcome);
        }
        return;
    }
  }

  private async notifyPush(input: {
    workspaceId: string | undefined;
    oldAgentId: string;
    oldTitle: string | null;
    newAgentId: string;
    targetProviderId: string;
  }): Promise<void> {
    try {
      await this.options.pushNotificationSender.send(
        buildAccountFailoverNotificationPayload({
          serverId: this.options.serverId,
          workspaceId: input.workspaceId,
          oldAgentId: input.oldAgentId,
          oldAgentTitle: input.oldTitle,
          newAgentId: input.newAgentId,
          targetProviderId: input.targetProviderId,
        }),
      );
    } catch (error) {
      this.options.logger.warn({ err: error }, "Account failover: push notification failed");
    }
  }

  private async notifyParent(outcome: MigratedOutcome): Promise<void> {
    if (!outcome.parentAgentId) {
      return;
    }
    // Same gate as AgentResourceMonitor: steering an idle agent starts a brand-new turn nobody is
    // driving (agent-prompt.ts falls back to a fresh run) and spends tokens on it. Read the
    // parent live — the import and resume prompt took time, and its lifecycle may have moved.
    const parent = this.options.agentManager.getAgent(outcome.parentAgentId);
    if (parent?.lifecycle !== "running") {
      return;
    }
    const providerRef = `${outcome.targetProviderId}/${outcome.model ?? "<model>"}`;
    const body =
      `Your subagent ${outcome.oldAgentId} hit the usage limit on "${outcome.oldProviderId}" and ` +
      `now continues as ${outcome.newAgentId} on "${outcome.targetProviderId}" with the same ` +
      `conversation. Do not relaunch ${outcome.oldAgentId}; if you already did, cancel one of the ` +
      `two. No finish notification will arrive for ${outcome.newAgentId}, so follow it with ` +
      `wait_for_agent or get_agent_activity. Create new subagents with provider "${providerRef}".`;
    try {
      await sendPromptToAgent({
        agentManager: this.options.agentManager,
        agentStorage: this.options.agentStorage,
        agentId: outcome.parentAgentId,
        prompt: formatSystemNotificationPrompt(body),
        activeTurnBehavior: "steer",
        unarchive: false,
        logger: this.options.logger,
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error, parentAgentId: outcome.parentAgentId },
        "Account failover: failed to notify the parent agent",
      );
    }
  }
}
