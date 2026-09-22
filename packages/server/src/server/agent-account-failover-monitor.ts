import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import pLimit from "p-limit";
import {
  buildAccountFailoverNotificationPayload,
  buildAccountPoolExhaustedNotificationPayload,
} from "@getpaseo/protocol/account-failover-notification";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary, AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import {
  DEFAULT_REACTIVE_SIGNAL_TTL_MS,
  isLimitShapedError,
  parseResetTimeHint,
  planAccountFailoverSweep,
  type LimitErrorSighting,
  type ProviderLimitSighting,
} from "./agent/account-failover-detector.js";
import { headroomByProvider } from "./agent/account-pool-headroom.js";
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
/**
 * Resume sends allowed per migration, the first one included — so two retries, one per sweep.
 *
 * Bounded rather than open-ended because nothing else will ever retry: the move clears the limit
 * error, and `planAccountFailoverSweep` only considers agents that have one, so a migrated agent
 * that never restarted is invisible to the detector forever. Keeping it eligible by preserving
 * that error would be worse than the stall it fixes — the error is limit-shaped and the agent now
 * sits on the target account, so the next sweep would read it as evidence that the *target* is
 * capped and condemn the account it was just rescued onto. Hence a queue of its own, bounded, and
 * when it runs out Tyler is told in words.
 */
const MAX_RESUME_ATTEMPTS = 3;

export interface AccountFailoverConfig {
  enabled?: boolean;
  migrateSubagents?: boolean;
  migrationConcurrency?: number;
  notifyParent?: boolean;
  /**
   * Whether the leader account may take a rescued agent once no worker can. Default `true`.
   *
   * `false` restores the strict isolation failover used to enforce, at the cost of stranding an
   * agent whenever every worker is out — which is the state Tyler's pool reaches when two
   * accounts run out for the week one after the other.
   */
  collapseToSharedAccount?: boolean;
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
  collapseToSharedAccount: boolean;
}

function resolveConfig(config: AccountFailoverConfig | undefined): ResolvedAccountFailoverConfig {
  return {
    migrateSubagents: config?.migrateSubagents ?? true,
    migrationConcurrency: config?.migrationConcurrency ?? DEFAULT_MIGRATION_CONCURRENCY,
    notifyParent: config?.notifyParent ?? true,
    collapseToSharedAccount: config?.collapseToSharedAccount ?? true,
  };
}

type MigratedOutcome = Extract<AccountFailoverOutcome, { kind: "migrated" }>;

/** A migration that landed on the target but never restarted. Retried on following sweeps. */
interface UnresumedAgent {
  agentId: string;
  title: string | null;
  workspaceId: string | undefined;
  oldAgentId: string;
  targetProviderId: string;
  prompt: string;
  /** Resume sends made so far, the original included. */
  attempts: number;
}

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
  private unresumed = new Map<string, UnresumedAgent>();
  /** The dead-account set already reported as exhausted, or null when the pool has targets. */
  private exhaustionEpisode: string | null = null;

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

    const nowMs = this.now();
    const usage = await this.readUsage();
    const plan = planAccountFailoverSweep({
      poolProviderIds: new Set(poolEntries.map((entry) => entry.providerId)),
      agents: this.options.agentManager.listAgentsForAccountFailover(),
      usage,
      previousSightings: this.sightings,
      previousProviderSightings: this.providerSightings,
      nowMs,
      reactiveSignalTtlMs: this.reactiveSignalTtlMs,
      migrateSubagents: config.migrateSubagents,
    });
    this.sightings = plan.sightings;
    this.providerSightings = plan.providerSightings;
    // Before the early return below: a queue of agents waiting to be restarted is work to do
    // even on a sweep that finds no new candidates, which is the usual case.
    await this.retryUnresumed();
    if (plan.candidates.length === 0) {
      return;
    }

    // Ranked from the same rows the plan read, so "which account is deadest" and "which has the
    // most left" can never disagree about what the usage said this sweep.
    const headroom = headroomByProvider(usage, nowMs);
    const limit = pLimit({ concurrency: config.migrationConcurrency });
    const outcomes = await Promise.all(
      plan.candidates.map((agent) =>
        limit(() =>
          this.migrateOne({
            agent,
            poolEntries,
            deadProviderIds: plan.deadProviderIds,
            headroom,
            sighting: plan.sightings.get(agent.id),
            config,
          }),
        ),
      ),
    );

    const stranded = plan.candidates.filter((_, index) => outcomes[index] === "no-target");
    await this.reportExhaustion({ stranded, poolEntries, deadProviderIds: plan.deadProviderIds });
  }

  /**
   * Nobody could be moved because there was nowhere to move them. Said once per episode, not
   * once per sweep and not once per agent: the sweep runs every 60 seconds, and an account that
   * is out for the week would otherwise produce a push a minute for days.
   *
   * The episode is keyed on the set of dead accounts, so it re-arms the moment that set changes
   * — an account recovering, or a new one going down, is a different situation and worth saying.
   * Stranding is the deliberate outcome here, not a failure to act: every remaining target would
   * fail on the first turn, so a move would spend a rescue to leave the agent exactly as stuck.
   */
  private async reportExhaustion(input: {
    stranded: readonly AccountFailoverAgentSummary[];
    poolEntries: readonly AccountPoolProviderEntry[];
    deadProviderIds: ReadonlySet<string>;
  }): Promise<void> {
    if (input.stranded.length === 0) {
      this.exhaustionEpisode = null;
      return;
    }
    const poolIds = input.poolEntries.map((entry) => entry.providerId);
    const deadPoolIds = poolIds.filter((providerId) => input.deadProviderIds.has(providerId));
    const episode = deadPoolIds.slice().sort().join(",");
    if (this.exhaustionEpisode === episode) {
      return;
    }
    this.exhaustionEpisode = episode;

    const resetHint = input.stranded
      .map((agent) => parseResetTimeHint(agent.lastError))
      .find((hint) => hint !== null);
    this.options.logger.error(
      { deadProviderIds: deadPoolIds, strandedAgentCount: input.stranded.length },
      "Account failover: every pool account is out of budget; agents are stranded where they are",
    );
    try {
      await this.options.pushNotificationSender.send(
        buildAccountPoolExhaustedNotificationPayload({
          serverId: this.options.serverId,
          providerIds: deadPoolIds.length > 0 ? deadPoolIds : poolIds,
          strandedAgentCount: input.stranded.length,
          resetHint,
        }),
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Account failover: pool-exhausted push notification failed",
      );
    }
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

  /**
   * Re-send the resume prompt to agents a migration left stalled on their new account.
   *
   * Every migration is queued, not only the ones whose send threw: `sendPromptToAgent` resolves
   * as soon as the turn starts, and a provider that refuses it reports that asynchronously. So
   * the only reliable evidence is the agent's state on a later sweep — an agent that resumed is
   * running or idle, and one that did not is sitting in `error`. One attempt per sweep, which
   * also gives a provider that was briefly busy a minute to settle.
   */
  private async retryUnresumed(): Promise<void> {
    const { logger } = this.options;
    // Deleting the current entry mid-iteration is well-defined for a Map, and nothing adds to
    // this queue during a drain — migrations run after it, in the same serialized sweep.
    for (const entry of this.unresumed.values()) {
      const summary = this.options.agentManager.getAccountFailoverSummary(entry.agentId);
      if (!summary) {
        // Archived, detached or unloaded while queued — nothing left to restart.
        this.unresumed.delete(entry.agentId);
        continue;
      }
      if (summary.lifecycle !== "error") {
        // Running, or idle after a turn it completed. The resume landed.
        this.unresumed.delete(entry.agentId);
        continue;
      }
      if (isLimitShapedError(summary.lastError)) {
        // The target account is capped too. That is the detector's job, not this queue's, and
        // both acting on one agent would race.
        this.unresumed.delete(entry.agentId);
        logger.info(
          { agentId: entry.agentId },
          "Account failover: the resumed agent hit a cap again; leaving it to the next sweep",
        );
        continue;
      }

      entry.attempts += 1;
      try {
        await sendPromptToAgent({
          agentManager: this.options.agentManager,
          agentStorage: this.options.agentStorage,
          agentId: entry.agentId,
          prompt: entry.prompt,
          messageId: randomUUID(),
          unarchive: false,
          logger,
        });
        logger.info(
          { agentId: entry.agentId, attempts: entry.attempts, lastError: summary.lastError },
          "Account failover: re-sent the resume prompt to a stalled agent",
        );
      } catch (error) {
        logger.warn(
          { err: error, agentId: entry.agentId, attempts: entry.attempts },
          "Account failover: could not re-send the resume prompt",
        );
      }
      if (entry.attempts < MAX_RESUME_ATTEMPTS) {
        continue;
      }
      // Out of attempts. Whether this send is refused like the others is decided after the sweep
      // that would check it, so stop here and hand it to a person either way.
      this.unresumed.delete(entry.agentId);
      logger.error(
        { agentId: entry.agentId, attempts: entry.attempts, lastError: summary.lastError },
        "Account failover: gave up restarting the agent on its new account",
      );
      await this.notifyPush({
        workspaceId: entry.workspaceId,
        oldAgentId: entry.oldAgentId,
        oldTitle: entry.title,
        newAgentId: entry.agentId,
        targetProviderId: entry.targetProviderId,
        resumed: false,
      });
    }
  }

  /** Watch a fresh migration until its resume prompt demonstrably landed. */
  private watchForResume(entry: UnresumedAgent): void {
    this.unresumed.set(entry.agentId, entry);
  }

  /** Returns the outcome kind, or "failed" when the migration threw. The sweep reads it to tell
   * "nowhere to go" apart from every other reason an agent didn't move. */
  private async migrateOne(input: {
    agent: AccountFailoverAgentSummary;
    poolEntries: readonly AccountPoolProviderEntry[];
    deadProviderIds: ReadonlySet<string>;
    headroom: ReadonlyMap<string, number>;
    sighting: LimitErrorSighting | undefined;
    config: ResolvedAccountFailoverConfig;
  }): Promise<AccountFailoverOutcome["kind"] | "failed"> {
    const { agent, poolEntries, deadProviderIds, config } = input;
    const { logger } = this.options;
    let outcome: AccountFailoverOutcome;
    try {
      outcome = await migrateStuckAgent({
        agent,
        poolEntries,
        deadProviderIds,
        headroom: input.headroom,
        allowLeaderTarget: config.collapseToSharedAccount,
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
      return "failed";
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
        this.watchForResume({
          agentId: outcome.agentId,
          title: outcome.title,
          workspaceId: outcome.workspaceId,
          oldAgentId: outcome.agentId,
          targetProviderId: outcome.targetProviderId,
          prompt: outcome.resume.prompt,
          attempts: 1,
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
        return outcome.kind;
      case "no-target":
        logger.warn(
          { agentId: agent.id, provider: agent.provider, deadProviderIds: [...deadProviderIds] },
          "Account failover: no account in the pool can take this agent; will retry next sweep",
        );
        return outcome.kind;
      case "adopted":
        logger.info(
          { agentId: outcome.oldAgentId, successorId: outcome.newAgentId },
          "Account failover: agent was already handed off; marked it retired",
        );
        return outcome.kind;
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
        this.watchForResume({
          agentId: outcome.newAgentId,
          title: outcome.oldTitle,
          workspaceId: outcome.workspaceId,
          oldAgentId: outcome.oldAgentId,
          targetProviderId: outcome.targetProviderId,
          prompt: outcome.resume.prompt,
          attempts: 1,
        });
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
        return outcome.kind;
    }
  }

  private async notifyPush(input: {
    workspaceId: string | undefined;
    oldAgentId: string;
    oldTitle: string | null;
    newAgentId: string;
    targetProviderId: string;
    resumed?: boolean;
  }): Promise<void> {
    try {
      await this.options.pushNotificationSender.send(
        buildAccountFailoverNotificationPayload({
          ...(input.resumed === undefined ? {} : { resumed: input.resumed }),
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
