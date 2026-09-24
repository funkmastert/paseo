import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { AccountFailoverAgentSummary, AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { sendPromptToAgent } from "./agent-prompt.js";
import { importProviderSession } from "./import-sessions.js";
import {
  ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL,
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  getHomeProviderFromLabels,
  getMigratedToFromLabels,
  HANDOFF_FROM_LABEL,
  isLimitShapedError,
  parseResetTimeHint,
} from "./account-failover-detector.js";
import { providersShareAccount } from "./account-failover-return.js";
import { pickFailoverTarget, type AccountPoolProviderEntry } from "./account-pool-providers.js";
import { AgentProviderMoveError } from "./provider-move.js";

/**
 * `agentManager`/`agentStorage` are the full types, unlike the sibling monitors' narrow
 * `Pick<>`s: the mechanics reused here on purpose — `importProviderSession` (workspace placement,
 * archived-record revival, per-session serialization) and `sendPromptToAgent` (load, stale-session
 * retry, dispatch) — require them.
 */
export interface MigrateStuckAgentInput {
  agent: AccountFailoverAgentSummary;
  poolEntries: readonly AccountPoolProviderEntry[];
  deadProviderIds: ReadonlySet<string>;
  /**
   * Per-provider budget headroom from `headroomByProvider`, used to rank otherwise-equal
   * targets. Absent (or missing a provider) means "rank on the configured priority order".
   */
  headroom?: ReadonlyMap<string, number>;
  /**
   * Whether the leader account may take a rescued agent when no worker can. Defaults to true —
   * see `pickFailoverTarget`.
   */
  allowLeaderTarget?: boolean;
  /** Account identity per pool provider id, from AgentManager.describeProviderAccount. */
  accounts: ReadonlyMap<string, AgentAccountAuth | null>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  logger: Logger;
}

/**
 * The resume prompt that restarts the conversation on its new account, and whether sending it
 * threw. `prompt` is carried so a retry re-sends the same text rather than rebuilding it from an
 * agent whose settings have since changed.
 *
 * A send that returns says almost nothing: the provider rejects the turn asynchronously, so the
 * usual failure lands on the agent as `lifecycle: "error"` long after this resolves. Whoever owns
 * the retry has to read the agent's state, not this field. It exists for the narrow synchronous
 * case (no such agent, archived, a turn already active).
 *
 * Either way the migration is only half-done, and nothing else will finish it: the move clears
 * the limit error, so `planAccountFailoverSweep` — which only considers limit-shaped errors —
 * will never see this agent again.
 */
export interface AccountFailoverResume {
  prompt: string;
  /** Set only when the send itself threw. */
  error: string | null;
}

export type AccountFailoverOutcome =
  /**
   * The conversation changed account without changing agent: same id, same timeline, same
   * parent/child links. Nothing is retired and nothing is imported, so there is no successor to
   * tell a parent about and no orphaned subagents to relaunch.
   */
  | {
      kind: "moved";
      agentId: string;
      title: string | null;
      oldProviderId: string;
      targetProviderId: string;
      model: string | undefined;
      workspaceId: string | undefined;
      resume: AccountFailoverResume;
    }
  | {
      kind: "migrated";
      oldAgentId: string;
      oldTitle: string | null;
      oldProviderId: string;
      newAgentId: string;
      targetProviderId: string;
      model: string | undefined;
      parentAgentId: string | null;
      workspaceId: string | undefined;
      /** The target already held a retired handle for this conversation; it was reused. */
      revived: boolean;
      /**
       * The reused handle's pre-existing limit error, captured before the resume prompt. It is
       * history, not new evidence; the monitor records it as an already-expired sighting.
       */
      staleError: { error: string; timelineSeq: number | null } | null;
      resume: AccountFailoverResume;
    }
  /** A successor already existed (an earlier sweep, or a person running `paseo import`). */
  | { kind: "adopted"; oldAgentId: string; newAgentId: string }
  /**
   * The conversation already runs under another live record, so this one is a duplicate left
   * over from an earlier handoff. Retired like an adopted predecessor, never moved, never retried.
   */
  | { kind: "duplicate"; oldAgentId: string; holderId: string; holderProviderId: string }
  | { kind: "no-target"; oldAgentId: string };

const MOVED_TITLE_PREFIX = /^\[MOVED [^\]]*\]\s*/;

export function stripMovedTitlePrefix(title: string): string {
  return title.replace(MOVED_TITLE_PREFIX, "");
}

/** Idempotent: a title that already carries a prefix (e.g. from a manual handoff) gets one, not two. */
export function formatMovedTitle(title: string, successorId: string): string {
  return `[MOVED → ${successorId}, out of budget] ${stripMovedTitlePrefix(title)}`;
}

function sessionHandlesOf(record: Pick<StoredAgentRecord, "persistence">): Set<string> {
  const handles = new Set<string>();
  const persistence = record.persistence;
  if (persistence?.sessionId) handles.add(persistence.sessionId);
  if (typeof persistence?.nativeHandle === "string") handles.add(persistence.nativeHandle);
  return handles;
}

function sharesSession(record: StoredAgentRecord, handles: ReadonlySet<string>): boolean {
  return [...sessionHandlesOf(record)].some((handle) => handles.has(handle));
}

function byCreatedAt(a: StoredAgentRecord, b: StoredAgentRecord): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Whether following migrated-to pointers from `start` arrives back at `targetId`. */
function handsBackTo(
  start: StoredAgentRecord,
  targetId: string,
  byId: ReadonlyMap<string, StoredAgentRecord>,
): boolean {
  const seen = new Set<string>();
  let current: StoredAgentRecord | undefined = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const next = getMigratedToFromLabels(current.labels);
    if (!next) return false;
    if (next === targetId) return true;
    current = byId.get(next);
  }
  return false;
}

/**
 * The agent this predecessor was already handed off to, if any: first a record naming it in
 * `handoff-from` (what both this service and the manual procedure write), else a record created
 * later on the same provider session (a manual `paseo import` without the label — every account
 * shares one transcript, so the successor keeps the predecessor's session id). A candidate that
 * has since handed the conversation back to this predecessor is not a successor: when a
 * conversation returns to an account, the returning handle is the live end again.
 */
export function findExistingSuccessor(
  predecessor: StoredAgentRecord,
  records: readonly StoredAgentRecord[],
): StoredAgentRecord | null {
  const byId = new Map(records.map((record) => [record.id, record]));
  const isForward = (record: StoredAgentRecord) =>
    record.id !== predecessor.id && !handsBackTo(record, predecessor.id, byId);

  const labeled = records
    .filter((record) => record.labels[HANDOFF_FROM_LABEL] === predecessor.id && isForward(record))
    .sort(byCreatedAt);
  if (labeled[0]) return labeled[0];

  const handles = sessionHandlesOf(predecessor);
  if (handles.size === 0) return null;
  const predecessorCreatedMs = Date.parse(predecessor.createdAt);
  const laterOnSameSession = records
    .filter(
      (record) =>
        sharesSession(record, handles) &&
        Date.parse(record.createdAt) > predecessorCreatedMs &&
        isForward(record),
    )
    .sort(byCreatedAt);
  return laterOnSameSession[0] ?? null;
}

/**
 * The live record that already holds this conversation, if any: unarchived, not retired, on the
 * same provider session. One conversation has one live end. When another record is it, this one is
 * the duplicate, whichever is older — moving it would be refused on the holder's account
 * (`session_conflict`) and would leave two live agents on one transcript anywhere else.
 *
 * A retired holder is not live. It is the handle this conversation left behind on that account,
 * and the import path revives it (see `migrateStuckAgent`).
 */
export function findLiveSessionHolder(
  agent: StoredAgentRecord,
  records: readonly StoredAgentRecord[],
): StoredAgentRecord | null {
  const handles = sessionHandlesOf(agent);
  if (handles.size === 0) return null;
  return (
    records.find(
      (record) =>
        record.id !== agent.id &&
        !record.archivedAt &&
        !getMigratedToFromLabels(record.labels) &&
        sharesSession(record, handles),
    ) ?? null
  );
}

async function retirePredecessor(
  agentManager: AgentManager,
  predecessor: StoredAgentRecord,
  successorId: string,
): Promise<void> {
  await agentManager.updateAgentMetadata(predecessor.id, {
    title: formatMovedTitle(predecessor.title ?? predecessor.id, successorId),
    labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: successorId },
  });
}

/** A retired handle on the target account becomes the live end of the conversation again. */
async function reactivateRevivedHandle(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  handleId: string;
  predecessorId: string;
}): Promise<void> {
  const record = await input.agentStorage.get(input.handleId);
  const title = record?.title ? stripMovedTitlePrefix(record.title) : "";
  await input.agentManager.updateAgentMetadata(input.handleId, {
    ...(title ? { title } : {}),
    // There is no public label-removal API; a blank value reads as unset
    // (getMigratedToFromLabels), which is all retirement checks look at.
    labels: {
      [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "",
      [HANDOFF_FROM_LABEL]: input.predecessorId,
    },
  });
}

async function restoreSessionSettings(input: {
  agentManager: AgentManager;
  agent: AccountFailoverAgentSummary;
  successorId: string;
  logger: Logger;
}): Promise<void> {
  const { agentManager, agent, successorId, logger } = input;
  const steps: Array<[string, () => Promise<unknown>]> = [];
  if (agent.model) {
    steps.push(["model", () => agentManager.setAgentModel(successorId, agent.model ?? null)]);
  }
  if (agent.thinkingOptionId) {
    steps.push([
      "thinking option",
      () => agentManager.setAgentThinkingOption(successorId, agent.thinkingOptionId ?? null),
    ]);
  }
  if (agent.modeId) {
    const modeId = agent.modeId;
    steps.push(["mode", () => agentManager.setAgentMode(successorId, modeId)]);
  }
  for (const [setting, restore] of steps) {
    try {
      await restore();
    } catch (error) {
      logger.warn(
        { err: error, successorId, setting },
        "Account failover: failed to restore a session setting on the successor",
      );
    }
  }
}

export function buildResumePrompt(input: {
  oldAgentId: string;
  oldProviderId: string;
  targetProviderId: string;
  model: string | undefined;
  thinkingOptionId: string | undefined;
  modeId: string | undefined;
  resetHint: string | null;
}): string {
  const providerRef = `${input.targetProviderId}/${input.model ?? "<model>"}`;
  const settings = [
    input.model ? `model ${input.model}` : null,
    input.thinkingOptionId ? `thinking ${input.thinkingOptionId}` : null,
    input.modeId ? `mode ${input.modeId}` : null,
  ].filter((value): value is string => value !== null);
  const settingsClause = settings.length > 0 ? ` with ${settings.join(", ")}` : "";
  const resetClause = input.resetHint ? ` (it reports a reset at ${input.resetHint})` : "";
  return [
    `Account handoff: agent ${input.oldAgentId} on provider "${input.oldProviderId}" hit that ` +
      `account's usage limit${resetClause}. This is the same conversation, now running on ` +
      `provider "${input.targetProviderId}"${settingsClause}.`,
    "",
    "1. Pick up where you left off: answer the latest message(s) that failed on the limit. If " +
      "the work was already done or is waiting on a person, orient, verify, report, and stop.",
    `2. Create every new subagent with provider "${providerRef}" explicitly. ` +
      `"${input.oldProviderId}" is out of budget, and the default provider or a role/model ` +
      "policy can still place an unqualified spawn there, where it dies immediately.",
    `3. Your existing subagents are still parented to ${input.oldAgentId}. Their finish ` +
      "reports are forwarded to you, but list_agents lists them under the old id. Check them " +
      "with get_agent_activity and relaunch only the ones that died on the limit, with " +
      `provider "${providerRef}".`,
  ].join("\n");
}

export function buildMoveResumePrompt(input: {
  agentId: string;
  oldProviderId: string;
  targetProviderId: string;
  model: string | undefined;
  resetHint: string | null;
}): string {
  const providerRef = `${input.targetProviderId}/${input.model ?? "<model>"}`;
  const resetClause = input.resetHint ? ` (it reports a reset at ${input.resetHint})` : "";
  return [
    `Account handoff: provider "${input.oldProviderId}" hit that account's usage ` +
      `limit${resetClause}. You are the same agent (${input.agentId}) with the same conversation ` +
      `and the same subagents, now running on provider "${input.targetProviderId}".`,
    "",
    "1. Pick up where you left off: answer the latest message(s) that failed on the limit. If " +
      "the work was already done or is waiting on a person, orient, verify, report, and stop.",
    `2. Create every new subagent with provider "${providerRef}" explicitly. ` +
      `"${input.oldProviderId}" is out of budget, and the default provider or a role/model ` +
      "policy can still place an unqualified spawn there, where it dies immediately.",
  ].join("\n");
}

/**
 * Remember which account this conversation came off, so the return leg can put it back
 * (docs/account-failover.md). Written after the move rather than before: a move that was refused
 * has taken nothing away and has no home to record.
 *
 * Only the first move writes it, and landing back on the recorded home clears it. Both halves
 * matter for a conversation that hops: A -> B -> C belongs to A, not B, and an ordinary rescue
 * that happens to pick A again has already completed the round trip, so leaving the label would
 * make the agent a return candidate for an account it is sitting on.
 *
 * Best-effort, like the other post-move steps. A failure here costs the round trip, not the rescue.
 */
async function recordHomeProvider(input: {
  agent: AccountFailoverAgentSummary;
  targetProviderId: string;
  agentManager: AgentManager;
  logger: Logger;
}): Promise<void> {
  const existingHome = getHomeProviderFromLabels(input.agent.labels);
  if (existingHome !== null && existingHome !== input.targetProviderId) {
    return;
  }
  // Blank reads as unset; there is no label-removal API.
  const home = existingHome === null ? input.agent.provider : "";
  try {
    await input.agentManager.updateAgentMetadata(input.agent.id, {
      labels: { [ACCOUNT_FAILOVER_HOME_PROVIDER_LABEL]: home },
    });
  } catch (error) {
    input.logger.warn(
      { err: error, agentId: input.agent.id, home },
      "Account failover: could not record the agent's home account",
    );
  }
}

/**
 * The preferred path: change the account under the agent instead of handing the conversation to a
 * new one. Returns null when the move cannot be used and the import path has to take over — a
 * target that still holds this conversation's retired handle is the routine case, since that
 * handle is the account's live record of the session and reviving it is what belongs there.
 */
async function moveStuckAgentInPlace(input: {
  agent: AccountFailoverAgentSummary;
  title: string | null;
  targetProviderId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Promise<AccountFailoverOutcome | null> {
  const { agent, targetProviderId, agentManager, agentStorage, logger } = input;
  try {
    await agentManager.moveAgentToProvider(agent.id, targetProviderId);
  } catch (error) {
    const refusal = error instanceof AgentProviderMoveError ? error : null;
    const duplicate = await retireIfDuplicate({
      refusal,
      agentId: agent.id,
      agentManager,
      agentStorage,
    });
    if (duplicate) {
      return duplicate;
    }
    logger.info(
      {
        err: refusal ? undefined : error,
        agentId: agent.id,
        targetProviderId,
        code: refusal?.code,
      },
      "Account failover: cannot move the agent in place; importing the session instead",
    );
    return null;
  }

  await recordHomeProvider({ agent, targetProviderId, agentManager, logger });

  // No settings to restore: a move keeps the agent's config, unlike an import.
  const model = agentManager.getAgent(agent.id)?.config.model;
  let resumeError: string | null = null;
  const prompt = buildMoveResumePrompt({
    agentId: agent.id,
    oldProviderId: agent.provider,
    targetProviderId,
    model,
    resetHint: parseResetTimeHint(agent.lastError),
  });
  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: agent.id,
      prompt,
      messageId: randomUUID(),
      unarchive: false,
      logger,
    });
  } catch (error) {
    logger.warn(
      { err: error, agentId: agent.id },
      "Account failover: failed to send the resume prompt after moving the agent",
    );
    resumeError = getErrorMessage(error);
  }

  return {
    kind: "moved",
    agentId: agent.id,
    title: input.title,
    oldProviderId: agent.provider,
    targetProviderId,
    model,
    workspaceId: agent.workspaceId,
    resume: { prompt, error: resumeError },
  };
}

/**
 * A `session_conflict` refusal names an account that already holds this conversation. If the
 * holder is live, this record is a duplicate and is retired; a retired holder is left to the
 * import path, which revives it. The check before the move normally catches a live holder; this
 * covers one that appeared in between.
 */
async function retireIfDuplicate(input: {
  refusal: AgentProviderMoveError | null;
  agentId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
}): Promise<AccountFailoverOutcome | null> {
  if (input.refusal?.code !== "session_conflict") return null;
  const self = await input.agentStorage.get(input.agentId);
  if (!self) return null;
  const holder = findLiveSessionHolder(self, await input.agentStorage.list());
  if (!holder) return null;
  await retirePredecessor(input.agentManager, self, holder.id);
  return {
    kind: "duplicate",
    oldAgentId: input.agentId,
    holderId: holder.id,
    holderProviderId: holder.persistence?.provider ?? holder.provider,
  };
}

async function sendResumePrompt(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agent: AccountFailoverAgentSummary;
  successorId: string;
  targetProviderId: string;
  logger: Logger;
}): Promise<AccountFailoverResume> {
  const { agentManager, agentStorage, agent, successorId, targetProviderId, logger } = input;
  // State what the successor actually has after restoration, not what was requested.
  const config = agentManager.getAgent(successorId)?.config;
  const prompt = buildResumePrompt({
    oldAgentId: agent.id,
    oldProviderId: agent.provider,
    targetProviderId,
    model: config?.model,
    thinkingOptionId: config?.thinkingOptionId,
    modeId: config?.modeId,
    resetHint: parseResetTimeHint(agent.lastError),
  });
  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: successorId,
      prompt,
      // A Paseo message id records the prompt as a timeline row, so if this attempt fails with
      // the same cap text the failure still reads as new (see planAccountFailoverSweep).
      messageId: randomUUID(),
      unarchive: false,
      logger,
    });
    return { prompt, error: null };
  } catch (error) {
    logger.warn(
      { err: error, successorId },
      "Account failover: failed to send the resume prompt to the successor",
    );
    return { prompt, error: getErrorMessage(error) };
  }
}

/**
 * Every account this agent may not be moved onto, beyond the ones already dead this sweep:
 *
 * - **The same Claude login as the account that ran dry.** Two providers signed into one account
 *   report the same usage windows because they *are* the same windows, so moving there cannot buy
 *   budget. Better to wait for a real target than to spend a move and a resume on nothing.
 * - **An account already holding a live record for this conversation.** That is someone else's
 *   copy, and a move would be refused by `session_conflict` anyway.
 */
function resolveUnavailableTargets(params: {
  input: MigrateStuckAgentInput;
  sameSession: readonly StoredAgentRecord[];
  agentManager: AgentManager;
}): Set<string> {
  const { input, sameSession, agentManager } = params;
  const unavailable = new Set(input.deadProviderIds);
  const sourceAccount = input.accounts.get(input.agent.provider);
  for (const entry of input.poolEntries) {
    if (
      entry.providerId !== input.agent.provider &&
      providersShareAccount(sourceAccount, input.accounts.get(entry.providerId))
    ) {
      unavailable.add(entry.providerId);
    }
  }
  for (const record of sameSession) {
    const live =
      !getMigratedToFromLabels(record.labels) ||
      agentManager.getAgent(record.id)?.lifecycle === "running";
    if (record.persistence && live) {
      unavailable.add(record.persistence.provider);
    }
  }
  return unavailable;
}

/** Children prefer a worker and collapse onto the leader account; roots prefer the leader account. */
function pickTarget(params: {
  input: MigrateStuckAgentInput;
  sameSession: readonly StoredAgentRecord[];
}): string | null {
  const { input, sameSession } = params;
  return pickFailoverTarget(input.poolEntries, {
    headroom: input.headroom,
    allowLeader: input.allowLeaderTarget,
    preferLeader: getParentAgentIdFromLabels(input.agent.labels) === null,
    deadProviderIds: resolveUnavailableTargets({
      input,
      sameSession,
      agentManager: input.agentManager,
    }),
    sourceProviderId: input.agent.provider,
  });
}

export type IdleRehomeOutcome =
  | { kind: "moved"; agentId: string; oldProviderId: string; targetProviderId: string }
  | Extract<AccountFailoverOutcome, { kind: "adopted" | "duplicate" | "no-target" }>
  /** The daemon would not move it, for a reason that is not a duplicate. Retried after a backoff. */
  | { kind: "refused"; agentId: string; targetProviderId: string; reason: string };

/**
 * Move an agent that is between turns off an exhausted account, in place, and send it nothing
 * (account-failover-rehome.ts). Same placement and duplicate rules as a rescue. Unlike a rescue it
 * never imports: a refused move leaves the agent where it is, and if it is asked to do something
 * there it fails on the cap and the rescue leg takes over.
 */
export async function rehomeIdleAgent(input: MigrateStuckAgentInput): Promise<IdleRehomeOutcome> {
  const { agent, agentManager, agentStorage, logger } = input;
  const self = await agentStorage.get(agent.id);
  if (!self) {
    throw new Error(`Agent ${agent.id} has no stored record`);
  }
  const records = await agentStorage.list();
  const existing = findExistingSuccessor(self, records);
  if (existing) {
    await retirePredecessor(agentManager, self, existing.id);
    return { kind: "adopted", oldAgentId: agent.id, newAgentId: existing.id };
  }
  const holder = findLiveSessionHolder(self, records);
  if (holder) {
    await retirePredecessor(agentManager, self, holder.id);
    return {
      kind: "duplicate",
      oldAgentId: agent.id,
      holderId: holder.id,
      holderProviderId: holder.persistence?.provider ?? holder.provider,
    };
  }

  const handles = sessionHandlesOf(self);
  const sameSession = records.filter(
    (record) => record.id !== agent.id && !record.archivedAt && sharesSession(record, handles),
  );
  const targetProviderId = pickTarget({ input, sameSession });
  if (!targetProviderId) {
    return { kind: "no-target", oldAgentId: agent.id };
  }
  try {
    await agentManager.moveAgentToProvider(agent.id, targetProviderId);
  } catch (error) {
    const refusal = error instanceof AgentProviderMoveError ? error : null;
    const duplicate = await retireIfDuplicate({
      refusal,
      agentId: agent.id,
      agentManager,
      agentStorage,
    });
    if (duplicate?.kind === "duplicate") {
      return duplicate;
    }
    return { kind: "refused", agentId: agent.id, targetProviderId, reason: getErrorMessage(error) };
  }
  await recordHomeProvider({ agent, targetProviderId, agentManager, logger });
  return { kind: "moved", agentId: agent.id, oldProviderId: agent.provider, targetProviderId };
}

/**
 * Move one stuck agent's conversation to a healthy account, following the
 * claude-account-handoff procedure: import the session (every account can read every
 * transcript), restore model/thinking/mode (import resets them), send an explicit resume prompt,
 * and retire the predecessor with a title prefix and label. The predecessor is never archived.
 *
 * Idempotency:
 * - A predecessor that already has a successor is adopted instead: retired, nothing imported,
 *   nothing sent. This covers crash recovery and handoffs a person already did by hand.
 * - The storage layer rejects importing a session that is already live on the target provider
 *   ("Provider session is already imported"). If that fires because another import won a race,
 *   the successor it created is adopted. If the target instead holds this conversation's retired
 *   handle (the conversation is returning to an account it left), that handle is reused.
 * - A conversation that already runs under another live record makes this one a duplicate: it is
 *   retired in favour of that record and nothing moves (`findLiveSessionHolder`).
 * - Children go to a worker first and collapse onto the leader account; roots go to the leader
 *   account first and to the worker with the most budget when it is out.
 *
 * Throws when the import itself fails; restoration and the resume prompt are best-effort.
 */
export async function migrateStuckAgent(
  input: MigrateStuckAgentInput,
): Promise<AccountFailoverOutcome> {
  const { agent, agentManager, agentStorage, logger } = input;
  const predecessor = await agentStorage.get(agent.id);
  if (!predecessor) {
    throw new Error(`Agent ${agent.id} has no stored record`);
  }
  if (!agent.sessionId) {
    throw new Error(`Agent ${agent.id} has no provider session to import`);
  }

  const records = await agentStorage.list();
  const existing = findExistingSuccessor(predecessor, records);
  if (existing) {
    await retirePredecessor(agentManager, predecessor, existing.id);
    return { kind: "adopted", oldAgentId: agent.id, newAgentId: existing.id };
  }

  const holder = findLiveSessionHolder(predecessor, records);
  if (holder) {
    await retirePredecessor(agentManager, predecessor, holder.id);
    return {
      kind: "duplicate",
      oldAgentId: agent.id,
      holderId: holder.id,
      holderProviderId: holder.persistence?.provider ?? holder.provider,
    };
  }

  const handles = sessionHandlesOf(predecessor);
  const sameSession = records.filter(
    (record) => record.id !== agent.id && !record.archivedAt && sharesSession(record, handles),
  );
  const targetProviderId = pickTarget({ input, sameSession });
  if (!targetProviderId) {
    return { kind: "no-target", oldAgentId: agent.id };
  }

  const moved = await moveStuckAgentInPlace({
    agent,
    title: predecessor.title ?? null,
    targetProviderId,
    agentManager,
    agentStorage,
    logger,
  });
  if (moved) {
    return moved;
  }

  const retiredHandle = sameSession.find(
    (record) => record.persistence?.provider === targetProviderId,
  );
  let successorId: string;
  let revived: boolean;
  if (retiredHandle) {
    await ensureAgentLoaded(retiredHandle.id, { agentManager, agentStorage, logger });
    successorId = retiredHandle.id;
    revived = true;
  } else {
    try {
      const { snapshot } = await importProviderSession({
        request: {
          provider: targetProviderId,
          providerHandleId: agent.sessionId,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId,
          labels: { ...agent.labels, [HANDOFF_FROM_LABEL]: agent.id },
          requestId: randomUUID(),
        },
        workspaceProvisioning: input.workspaceProvisioning,
        agentManager,
        agentStorage,
        logger,
      });
      successorId = snapshot.id;
      // An archived record for this session on the target is revived by the import itself.
      revived = records.some((record) => record.id === snapshot.id);
    } catch (error) {
      const raced = findExistingSuccessor(predecessor, await agentStorage.list());
      if (!raced) {
        throw error;
      }
      await retirePredecessor(agentManager, predecessor, raced.id);
      return { kind: "adopted", oldAgentId: agent.id, newAgentId: raced.id };
    }
  }

  let staleError: { error: string; timelineSeq: number | null } | null = null;
  if (revived) {
    await reactivateRevivedHandle({
      agentManager,
      agentStorage,
      handleId: successorId,
      predecessorId: agent.id,
    });
    const handle = agentManager.getAccountFailoverSummary(successorId);
    if (handle && isLimitShapedError(handle.lastError)) {
      staleError = { error: handle.lastError, timelineSeq: handle.timelineSeq };
    }
  }
  // Retire before the best-effort steps: from here on the successor exists, and a crash or a
  // failed restore must converge through adoption, never through a second import.
  await retirePredecessor(agentManager, predecessor, successorId);
  await restoreSessionSettings({ agentManager, agent, successorId, logger });
  const resume = await sendResumePrompt({
    agentManager,
    agentStorage,
    agent,
    successorId,
    targetProviderId,
    logger,
  });

  return {
    kind: "migrated",
    oldAgentId: agent.id,
    oldTitle: predecessor.title ?? null,
    oldProviderId: agent.provider,
    newAgentId: successorId,
    targetProviderId,
    model: agentManager.getAgent(successorId)?.config.model,
    parentAgentId: getParentAgentIdFromLabels(agent.labels),
    workspaceId: agent.workspaceId,
    revived,
    staleError,
    resume,
  };
}
