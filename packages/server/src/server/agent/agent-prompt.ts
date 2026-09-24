import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
  AgentSteerOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { FinishOutcomeReason } from "./finish-obligation.js";
import { PromptQueue, type QueuedPrompt, type QueuedPromptDelivery } from "./prompt-queue.js";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerIntoActiveTurn"
  | "streamAgent"
> &
  Partial<
    Pick<AgentManager, "interceptPromptForDispatch" | "getAdmittedTurn" | "getPromptQueue">
  > & {
    reloadAgentSession(agentId: string): Promise<unknown>;
  };

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  /**
   * "steer" joins the running turn, or waits for it and runs next; it never cancels anything.
   * Only an explicit "interrupt" (with `replaceRunning`) replaces a running turn.
   */
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
  /** A child turn held across a restart: if it queues again, it keeps its original place. */
  queuedAt?: string;
}

/**
 * `queued`: the agent is busy with a run the prompt could not join. It is delivered, in order, as
 * soon as that run takes a steer or ends.
 */
export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started" | "queued";

/** Per manager: the queue used when none is wired, as in a daemon with no agent records. */
const memoryQueues = new WeakMap<AgentRunController, PromptQueue>();

function promptQueueFor(agentManager: AgentRunController, logger: Logger): PromptQueue {
  const wired = agentManager.getPromptQueue?.();
  if (wired) return wired;
  let queue = memoryQueues.get(agentManager);
  if (!queue) {
    queue = new PromptQueue({
      store: null,
      deliver: (agentId, prompt) => deliverQueuedPrompt({ agentManager, agentId, prompt, logger }),
      logger,
    });
    memoryQueues.set(agentManager, queue);
  }
  return queue;
}

/** The daemon's queue: it lives on the agent records and is delivered again after a restart. */
export function createPromptQueue(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): PromptQueue {
  const { agentManager, agentStorage, logger } = input;
  return new PromptQueue({
    store: agentStorage,
    logger,
    deliver: (agentId, prompt) =>
      deliverQueuedPrompt({
        agentManager,
        agentId,
        prompt,
        logger,
        loadAgent: async (id) => {
          const record = await agentStorage.get(id);
          if (!record || record.archivedAt) return false;
          await ensureAgentLoaded(id, { agentManager, agentStorage, logger });
          return true;
        },
      }),
  });
}

function steerOptionsFor(options: StartAgentRunOptions | undefined): AgentSteerOptions | undefined {
  return options?.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options?.runOptions;
}

/**
 * A message is never a stop. It joins the running turn; when the turn cannot take it, it waits
 * behind the run instead of replacing it, because replacing interrupts the provider, and in
 * Claude Code that aborts every background Workflow and Agent task the session has running.
 */
async function steerOrWaitForActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" | "queued" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const queue = promptQueueFor(agentManager, logger);
  // Anything already waiting goes first; a later message must not overtake it.
  if (!queue.hasWaiting(agentId)) {
    const result = await agentManager.steerIntoActiveTurn(
      agentId,
      prompt,
      steerOptionsFor(options),
    );
    if (result.status === "steered") {
      return { disposition: "steered" };
    }
    // Checked and started in one tick, so no other dispatch can start a run in between.
    if (
      result.status === "inactive" &&
      !agentManager.hasInFlightRun(agentId) &&
      !queue.hasWaiting(agentId)
    ) {
      return {
        disposition: "turn_started",
        iterator: agentManager.streamAgent(agentId, prompt, options.runOptions, options.queuedAt),
      };
    }
  }
  const clientMessageId = options.runOptions?.clientMessageId;
  await queue.enqueue(agentId, {
    prompt,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(options.clearPendingPermissions ? { clearPendingPermissions: true } : {}),
  });
  return { disposition: "queued" };
}

/**
 * Delivers one queued message: joins the agent's turn, or waits for its run and starts the next
 * turn. Never replaces anything. A stored agent that is not live is loaded first when `loadAgent`
 * is given; without it, or when the agent is archived or gone, the message is dropped.
 */
export async function deliverQueuedPrompt(input: {
  agentManager: AgentRunController;
  agentId: string;
  prompt: QueuedPrompt;
  logger: Logger;
  loadAgent?: (agentId: string) => Promise<boolean>;
}): Promise<QueuedPromptDelivery> {
  const { agentManager, agentId, prompt, logger } = input;
  const runOptions = prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {};
  const steerOptions = prompt.clearPendingPermissions
    ? { ...runOptions, clearPendingPermissions: true }
    : runOptions;
  for (;;) {
    if (!agentManager.getAgent(agentId)) {
      if (!input.loadAgent || !(await input.loadAgent(agentId))) return "dropped";
    }
    const result = await agentManager.steerIntoActiveTurn(agentId, prompt.prompt, steerOptions);
    if (result.status === "steered") return "delivered";
    if (result.status === "busy") {
      await result.nextOpportunity;
      continue;
    }
    if (agentManager.hasInFlightRun(agentId)) continue;
    try {
      // Idle: start the turn through the ordinary path, which never replaces without
      // `replaceRunning`, so a run that appears in the meantime is refused, not interrupted.
      await startAgentRunWithStaleRetry(agentManager, agentId, prompt.prompt, logger, {
        runOptions,
      });
      return "delivered";
    } catch (error) {
      if (!agentManager.hasInFlightRun(agentId)) throw error;
    }
  }
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions, options?.queuedAt);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { disposition: "out_of_band" };
  }
  // Refocus rides on this prompt when one is due (agent-refocus.ts). It only ever adds to a
  // prompt that is being sent anyway, so every surface gets it without ever starting a turn.
  const interception = agentManager.interceptPromptForDispatch?.(agentId, prompt) ?? null;
  const dispatchPrompt = interception?.prompt ?? prompt;
  try {
    const result = await startAgentRunWithStaleRetry(
      agentManager,
      agentId,
      dispatchPrompt,
      logger,
      options,
    );
    interception?.settle(true);
    return result;
  } catch (error) {
    interception?.settle(false);
    throw error;
  }
}

async function startAgentRunWithStaleRetry(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrWaitForActiveRun(agentManager, agentId, prompt, logger, options);
  if (steered && steered.disposition !== "turn_started") {
    return { disposition: steered.disposition };
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: false }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        // A queued child's turn may have started with later prompts merged into this one; those
        // callers got an empty stream, so the retry has to carry what was really sent.
        const admitted = agentManager.getAdmittedTurn?.(iterator);
        const retryOptions = admitted?.options
          ? { ...options, runOptions: admitted.options }
          : options;
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(
          agentManager,
          agentId,
          admitted?.prompt ?? prompt,
          retryOptions,
        );
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { disposition: "turn_started" };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  /**
   * Defaults to "steer". A message never cancels in-flight work unless the sender explicitly asks
   * for "interrupt"; MCP, the CLI and clients older than steering send nothing.
   */
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  /** See {@link StartAgentRunOptions.queuedAt}. */
  queuedAt?: string;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    activeTurnBehavior: params.activeTurnBehavior ?? "steer",
    clearPendingPermissions: params.clearPendingPermissions,
    ...(params.queuedAt ? { queuedAt: params.queuedAt } : {}),
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
  /**
   * Set when the durable ledger re-attaches a watcher to an obligation it already holds — after a
   * restart, or for a successor — so this call watches that generation instead of arming anew.
   */
  rearmedGeneration?: number;
}

type FinishNotificationReason = FinishOutcomeReason | "needs permission";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

export interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
  /** The predecessor this agent took the work over from, named so the owner can match it up. */
  inheritedFrom?: string;
  /** Extra paragraphs the ledger adds after the status line. */
  notes?: readonly string[];
}

export function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const successor = params.inheritedFrom ? `, which took over from ${params.inheritedFrom},` : "";
  const statusLine = `Agent ${params.childAgentId} (${params.title})${successor} ${params.reason}.`;
  const sections = [statusLine, ...(params.notes ?? [])];
  if (params.reason === "stopped before reporting") {
    // Sent by the daemon's sweep, not the agent: its turn ended without reaching an outcome,
    // almost always because the daemon restarted under it. Without this the parent reads the
    // silence as a result, or never hears anything at all.
    sections.push(
      "It stopped before finishing its turn — the daemon restarted or its runtime exited — so " +
        "this report comes from the daemon, not from the agent. Its conversation is intact. " +
        "Read get_agent_activity to see how far it got, then send it a message with " +
        "send_agent_prompt to have it continue. Do not create another agent for the same task.",
    );
  }
  if (params.reason === "was canceled") {
    // A cancelled delegation produced no answer. Told it "finished" with an empty response, a
    // parent reads the silence as a result it did not understand and creates the agent again —
    // one parent made four of the same subagent in 45 seconds that way.
    sections.push(
      "It did not finish its work, and whatever it did produce is incomplete. Do not create " +
        "another agent for the same task until you know why this one was stopped: check it " +
        "with get_agent_activity, and check its provider with inspect_provider.",
    );
  }
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  // The durable ledger (docs/finish-reports.md) is the one path that delivers a finish report: it
  // records the outcome on the child's record and delivers through its retry/escalation ladder,
  // so the report survives a restart and is sent once. This closure only notices the outcome. It
  // used to deliver the report itself when no ledger was wired, and two such watchers for one
  // child both delivered it; the second delivery replaced the turn the first had started.
  const ledger = agentManager.getFinishObligations();
  if (!ledger) {
    throw new Error("Finish reports need the finish-obligation service, and none is wired");
  }
  const obligations = ledger;
  let hasSeenRunning = false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();
  // Tells the manager someone is watching this child, so a permission it blocks on is answered
  // here rather than escalated to a person. Released the moment this observer stops.
  const releaseObserver = agentManager.noteFinishObserver(childAgentId);
  const generation =
    params.rearmedGeneration ??
    obligations.arm({ childAgentId, ownerAgentId: callerAgentId, requireParentOwnership });
  const releaseWatcher = obligations.noteWatcher(childAgentId, callerAgentId, generation);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    releaseObserver();
    releaseWatcher();
    unsubscribe?.();
  }

  /** A newer arm for the same child and owner supersedes this watcher; only one may report. */
  function isSuperseded(): boolean {
    return !obligations.isCurrent(childAgentId, callerAgentId, generation);
  }

  /** A permission the child blocks on. Not a finish report: the ledger does not carry these. */
  async function notifyPermission(permissionRequest: AgentPermissionRequest): Promise<void> {
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      // An archived caller will never read another notification, so this observer is dead. Say
      // so rather than staying registered: while it counts as a watcher, a permission the child
      // blocks on is suppressed as "someone will answer it" when nobody will.
      stop();
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason: "needs permission",
      lastAssistantMessage,
      permissionRequest,
    });

    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(body),
      activeTurnBehavior: "steer",
      unarchive: false,
      logger,
    });
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    const terminal = options.terminal ?? true;
    if (terminal) stop();
    if (reason === "needs permission") {
      const permissionRequest = options.permissionRequest;
      if (!permissionRequest) return;
      notificationQueue = notificationQueue
        .then(() => notifyPermission(permissionRequest))
        .catch((error) => {
          logger.error(
            { err: error, childAgentId, callerAgentId, reason },
            "Failed to notify caller agent",
          );
          // The in-band delivery that justifies keeping a delegated agent silent just failed, so
          // fall back to flagging the child for a person.
          agentManager.flagUndeliveredDelegatedOutcome(childAgentId, "permission");
        });
      return;
    }
    if (reason === "was closed" && obligations.isShuttingDown()) {
      // Every agent is closed on the way down. That is not this child's outcome: its report
      // stays owed on the record, and the restarted daemon picks it up.
      return;
    }
    notificationQueue = notificationQueue
      .then(() =>
        obligations.settle({ childAgentId, ownerAgentId: callerAgentId, generation, reason }),
      )
      .catch((error) => {
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to record a finish report",
        );
      });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }
      if (isSuperseded()) {
        stop();
        return;
      }

      if (event.type === "agent_state") {
        for (const requestId of notifiedPermissionRequestIds) {
          if (!event.agent.pendingPermissions.has(requestId)) {
            notifiedPermissionRequestIds.delete(requestId);
          }
        }
        if (event.agent.lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) {
            hasSeenRunning = true;
          }
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          // `turnCanceled` is set by both cancel paths and cleared at the same edge the manager
          // evaluates attention on, so reading it here is reading the outcome of this turn.
          notifySafely(event.agent.turnCanceled === true ? "was canceled" : "finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          notifySafely("was closed");
          return;
        }
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    stop();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
