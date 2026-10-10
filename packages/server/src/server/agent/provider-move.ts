/**
 * Policy for moving a live agent to another provider in place — same agent id, same conversation,
 * same labels and parent/child links. Pure: the manager supplies the facts and performs the swap.
 * See docs/account-failover.md.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { AgentProvider } from "./agent-sdk-types.js";

export type AgentProviderMoveRefusalCode =
  | "unknown_provider"
  | "provider_disabled"
  | "provider_unavailable"
  | "same_provider"
  | "no_session"
  | "incompatible_provider"
  | "session_unreachable"
  | "session_conflict"
  | "agent_busy";

export class AgentProviderMoveError extends Error {
  constructor(
    readonly code: AgentProviderMoveRefusalCode,
    readonly agentId: string,
    readonly targetProviderId: AgentProvider,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderMoveError";
  }
}

/**
 * A provider's session family: the built-in provider whose client actually reads and writes the
 * transcript. Derived accounts (`extends: "claude"`) share their base's family and therefore its
 * sessions; two providers that resolve to different roots cannot re-open each other's threads.
 */
export function resolveProviderSessionFamily(
  providerId: AgentProvider,
  getDerivedFrom: (providerId: AgentProvider) => string | null | undefined,
): AgentProvider {
  const seen = new Set<AgentProvider>();
  let current = providerId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = getDerivedFrom(current);
    if (!parent) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** The turn states that make a move unsafe: closing or re-opening a session under them loses work. */
const BUSY_LIFECYCLES: ReadonlySet<AgentLifecycleStatus> = new Set([
  "running",
  "initializing",
  "closed",
]);

export interface AgentProviderMoveCheckInput {
  agentId: string;
  sourceProviderId: AgentProvider;
  targetProviderId: AgentProvider;
  registeredProviderIds: readonly AgentProvider[];
  targetEnabled: boolean;
  sourceFamily: AgentProvider;
  targetFamily: AgentProvider;
  sessionId: string | null;
  lifecycle: AgentLifecycleStatus;
  hasInFlightRun: boolean;
}

/**
 * The refusals a move can decide without touching the provider — everything the caller can fix by
 * choosing a different target, finishing the turn, or importing instead. Availability, transcript
 * reachability, and session conflicts need I/O and are checked by the manager.
 */
export function checkAgentProviderMove(
  input: AgentProviderMoveCheckInput,
): AgentProviderMoveError | null {
  const refuse = (code: AgentProviderMoveRefusalCode, message: string) =>
    new AgentProviderMoveError(code, input.agentId, input.targetProviderId, message);

  if (input.targetProviderId === input.sourceProviderId) {
    return refuse(
      "same_provider",
      `Agent ${input.agentId} is already on provider '${input.targetProviderId}'.`,
    );
  }
  if (!input.registeredProviderIds.includes(input.targetProviderId)) {
    return refuse(
      "unknown_provider",
      `Provider '${input.targetProviderId}' is not registered on this host. ` +
        `Registered providers: ${[...input.registeredProviderIds].sort().join(", ")}.`,
    );
  }
  if (!input.targetEnabled) {
    return refuse(
      "provider_disabled",
      `Provider '${input.targetProviderId}' is disabled. Enable it in agents.providers first.`,
    );
  }
  if (!input.sessionId) {
    return refuse(
      "no_session",
      `Agent ${input.agentId} has no provider session, so there is nothing to re-open on ` +
        `'${input.targetProviderId}'. Send it a message first, or create a new agent there.`,
    );
  }
  if (input.sourceFamily !== input.targetFamily) {
    return refuse(
      "incompatible_provider",
      `Agent ${input.agentId} runs a '${input.sourceFamily}' session and '${input.targetProviderId}' ` +
        `runs '${input.targetFamily}' sessions, which cannot read it. Move it to another ` +
        `'${input.sourceFamily}' account, or start a new agent on '${input.targetProviderId}'.`,
    );
  }
  if (input.hasInFlightRun) {
    return refuse(
      "agent_busy",
      `Agent ${input.agentId} has a turn in flight. Moving it would close the session under the ` +
        "running turn and lose it. Cancel the turn or wait for it to finish, then move it.",
    );
  }
  if (BUSY_LIFECYCLES.has(input.lifecycle)) {
    return refuse(
      "agent_busy",
      `Agent ${input.agentId} is ${input.lifecycle} and has no settled session to re-open. ` +
        "Wait until it is idle, then move it.",
    );
  }
  return null;
}
