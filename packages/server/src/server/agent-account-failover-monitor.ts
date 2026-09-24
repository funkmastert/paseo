import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import pLimit from "p-limit";
import {
  buildAccountFailoverNotificationPayload,
  buildAccountPoolExhaustedNotificationPayload,
  buildAccountFailoverReturnNotificationPayload,
} from "@getpaseo/protocol/account-failover-notification";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountFailoverAgentSummary, AgentManager } from "./agent/agent-manager.js";
import type { AgentAccountAuth } from "./agent/agent-sdk-types.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import {
  ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL,
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
  homeReturnBlockedReason,
  planAccountFailoverReturns,
  resolveReturnConfig,
  type AccountFailoverReturnConfig,
  type HomeDrop,
  type ResolvedReturnConfig,
  type ReturnCandidate,
} from "./agent/account-failover-return.js";
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

export interface AccountFailoverConfig extends AccountFailoverReturnConfig {
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
  return: ResolvedReturnConfig;
}

function resolveConfig(config: AccountFailoverConfig | undefined): ResolvedAccountFailoverConfig {
  return {
    migrateSubagents: config?.migrateSubagents ?? true,
    migrationConcurrency: config?.migrationConcurrency ?? DEFAULT_MIGRATION_CONCURRENCY,
    notifyParent: config?.notifyParent ?? true,
    collapseToSharedAccount: config?.collapseToSharedAccount ?? true,
    return: resolveReturnConfig(config),
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
  /**
   * Per-agent earliest next return attempt. In memory on purpose, unlike the home label: forgetting
   * a cooldown across a restart costs at most one extra move, and every other return gate — home
   * healthy on a fresh read, agent quiet, home not dead — still has to pass first.
   */
  private returnCooldowns = new Map<string, number>();

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
      this.returnCooldowns.clear();
      return;
    }

    const nowMs = this.now();
    const agents = this.options.agentManager.listAgentsForAccountFailover();
    const usage = await this.readUsage();
    const accounts = await this.readPoolAccounts(poolEntries);
    const plan = planAccountFailoverSweep({
      poolProviderIds: new Set(poolEntries.map((entry) => entry.providerId)),
      agents,
      usage: usage?.providers ?? null,
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
    // Ranked from the same rows the plan read, so "which account is deadest" and "which has the
    // most left" can never disagree about what the usage said this sweep.
    const headroom = headroomByProvider(usage?.providers ?? null, nowMs);
    // Rescues first, returns after. A rescue is urgent and a return is not, and an account that is
    // capped right now is already excluded from being returned to by `deadProviderIds`. Returns do
    // not wait for a sweep with no rescues in it: a stuck agent with nowhere healthy to go is a
    // candidate on every sweep, and it must not starve the round trip of everybody else.
    const limit = pLimit({ concurrency: config.migrationConcurrency });
    const outcomes = await Promise.all(
      plan.candidates.map((agent) =>
        limit(() =>
          this.migrateOne({
            agent,
            poolEntries,
            deadProviderIds: plan.deadProviderIds,
            headroom,
            accounts,
            sighting: plan.sightings.get(agent.id),
            config,
          }),
        ),
      ),
    );

    const stranded = plan.candidates.filter((_, index) => outcomes[index] === "no-target");
    await this.reportExhaustion({ stranded, poolEntries, deadProviderIds: plan.deadProviderIds });
    await this.returnAgentsHome({
      // Re-read: the migrations above moved agents and wrote home labels.
      agents:
        plan.candidates.length === 0
          ? agents
          : this.options.agentManager.listAgentsForAccountFailover(),
      poolEntries,
      deadProviderIds: plan.deadProviderIds,
      accounts,
      config: config.return,
    });
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

  private async readUsage(options?: {
    forceRefresh: boolean;
  }): Promise<{ providers: ProviderUsage[]; fetchedAtMs: number | null } | null> {
    try {
      const result = await this.options.providerUsage.listUsage(options);
      const fetchedAtMs = Date.parse(result.fetchedAt);
      return {
        providers: result.providers,
        fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
      };
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Account failover: provider usage unreadable, using the reactive signal only",
      );
      return null;
    }
  }

  /**
   * Which Claude login each pool account is signed into, so two providers that turn out to be one
   * account are neither a rescue target for each other nor somewhere to return to. A file read per
   * entry (docs/providers.md), so it is cheap enough to do every sweep and does not need caching.
   */
  private async readPoolAccounts(
    poolEntries: readonly AccountPoolProviderEntry[],
  ): Promise<Map<string, AgentAccountAuth | null>> {
    const entries = await Promise.all(
      poolEntries.map(
        async (entry) =>
          [
            entry.providerId,
            await this.options.agentManager.describeProviderAccount(entry.providerId),
          ] as const,
      ),
    );
    return new Map(entries);
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
    accounts: ReadonlyMap<string, AgentAccountAuth | null>;
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
        accounts: input.accounts,
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
        // Its owner was already told "errored" when it hit the cap. The resume prompt restarts
        // that work, so the owner is owed a second report when it actually finishes.
        this.options.agentManager.getFinishObligations()?.carryOver(outcome.agentId);
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

  /**
   * The return leg: put agents a rescue took off their own account back on it, once that account's
   * window has demonstrably reset. Never a rescue and never urgent — it moves only idle agents with
   * nothing in flight, and it sends no prompt. There is nothing to resume: the agent already
   * finished whatever it was doing, and a prompt would start a turn nobody is driving. The next
   * message anyone sends it runs on its own budget again.
   */
  private async returnAgentsHome(input: {
    agents: readonly AccountFailoverAgentSummary[];
    poolEntries: readonly AccountPoolProviderEntry[];
    deadProviderIds: ReadonlySet<string>;
    accounts: ReadonlyMap<string, AgentAccountAuth | null>;
    config: ResolvedReturnConfig;
  }): Promise<void> {
    const plan = planAccountFailoverReturns({
      agents: input.agents,
      poolEntries: input.poolEntries,
      deadProviderIds: input.deadProviderIds,
      accounts: input.accounts,
      cooldowns: this.returnCooldowns,
      nowMs: this.now(),
      config: input.config,
    });
    for (const drop of plan.drops) {
      await this.dropHomeProvider(drop);
    }
    if (plan.candidates.length === 0) {
      return;
    }

    // One forced read for the whole sweep, and only now that something is waiting on the answer:
    // the cached read the dead-account signals ran on can predate the window rolling by minutes,
    // which is exactly the difference between a window that reset and one that is about to.
    const fresh = await this.readUsage({ forceRefresh: true });
    const nowMs = this.now();
    const blocked = new Map<string, string | null>();
    for (const candidate of plan.candidates) {
      if (!blocked.has(candidate.homeProviderId)) {
        blocked.set(
          candidate.homeProviderId,
          homeReturnBlockedReason({
            homeProviderId: candidate.homeProviderId,
            usage: fresh?.providers ?? null,
            fetchedAtMs: fresh?.fetchedAtMs ?? null,
            nowMs,
            config: input.config,
          }),
        );
      }
      const reason = blocked.get(candidate.homeProviderId) ?? null;
      if (reason !== null) {
        this.options.logger.debug(
          { agentId: candidate.agentId, home: candidate.homeProviderId, reason },
          "Account failover: not returning the agent home yet",
        );
        continue;
      }
      await this.returnOne(candidate, input.config);
    }
  }

  /** Blank a home label that no longer points at an account this agent could go back to. */
  private async dropHomeProvider(drop: HomeDrop): Promise<void> {
    try {
      await this.options.agentManager.updateAgentMetadata(drop.agentId, {
        labels: { [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: "" },
      });
      this.returnCooldowns.delete(drop.agentId);
      this.options.logger.info(
        { agentId: drop.agentId, home: drop.homeProviderId, reason: drop.reason },
        "Account failover: dropped the agent's home account",
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error, agentId: drop.agentId, home: drop.homeProviderId },
        "Account failover: could not drop the agent's home account",
      );
    }
  }

  private async returnOne(candidate: ReturnCandidate, config: ResolvedReturnConfig): Promise<void> {
    const { logger } = this.options;
    try {
      await this.options.agentManager.moveAgentToProvider(
        candidate.agentId,
        candidate.homeProviderId,
      );
    } catch (error) {
      // A refusal is nearly always structural, so back off rather than retry every sweep. The
      // label stays: the agent still belongs on its home account, and a later sweep may find the
      // reason gone.
      this.returnCooldowns.set(candidate.agentId, this.now() + config.retryBackoffMs);
      logger.info(
        { err: error, agentId: candidate.agentId, home: candidate.homeProviderId },
        "Account failover: could not move the agent back to its home account",
      );
      return;
    }
    this.returnCooldowns.set(candidate.agentId, this.now() + config.cooldownMs);
    logger.info(
      {
        agentId: candidate.agentId,
        from: candidate.fromProviderId,
        to: candidate.homeProviderId,
      },
      "Account failover: returned the agent to its own account",
    );
    await this.dropHomeProvider({
      agentId: candidate.agentId,
      homeProviderId: candidate.homeProviderId,
      reason: "already-home",
    });
    try {
      await this.options.pushNotificationSender.send(
        buildAccountFailoverReturnNotificationPayload({
          serverId: this.options.serverId,
          workspaceId: candidate.workspaceId,
          agentId: candidate.agentId,
          agentTitle: candidate.title,
          homeProviderId: candidate.homeProviderId,
          fromProviderId: candidate.fromProviderId,
        }),
      );
    } catch (error) {
      logger.warn({ err: error }, "Account failover: return push notification failed");
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
        {
          // A move that carried on is news. One that could not restart the agent needs a person.
          level: input.resumed === false ? "alert" : "notice",
          dedupeKey: `account-failover:${input.oldAgentId}:${input.resumed === false ? "stuck" : "moved"}`,
        },
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
      `two. Its finish notification arrives from ${outcome.newAgentId}. Create new subagents with ` +
      `provider "${providerRef}".`;
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
