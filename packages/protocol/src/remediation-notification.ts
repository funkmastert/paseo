/**
 * Push payloads for the remediation ladder (docs/remediation.md). `data.reason` is untyped JSON on
 * the wire, like resource-monitor-notification.ts's reasons, so a client that does not know a
 * value falls back to opening by `agentId`, else the server.
 */
export type RemediationNotificationReason =
  /** Recorded: an episode opened. */
  | "remediation_opened"
  /** Recorded: a remediation agent was created for the episode. */
  | "remediation_agent_started"
  /** Recorded: the remediation agent reported FIXED. */
  | "remediation_fixed"
  /** Recorded: the condition cleared and the episode closed. */
  | "remediation_resolved"
  /** Rung 3: the ladder could not fix it and a person has to look. */
  | "remediation_escalated";

export interface RemediationNotificationData {
  [key: string]: unknown;
  serverId: string;
  reason: RemediationNotificationReason;
  /** The condition instance, e.g. `stalled-agent:<agentId>`. */
  key: string;
  kind: string;
  agentId?: string;
  workspaceId?: string;
}

export interface RemediationNotificationPayload {
  title: string;
  body: string;
  data: RemediationNotificationData;
}

export interface RemediationNotificationAttempt {
  remedy: string;
  outcome: string;
  detail: string;
}

interface RemediationNotificationBase {
  serverId: string;
  key: string;
  kind: string;
  /** The condition's own title, from the monitor. */
  title: string;
  agentId?: string;
  workspaceId?: string;
}

const MAX_LISTED_ATTEMPTS = 3;

function formatAttempts(attempts: readonly RemediationNotificationAttempt[]): string | null {
  if (attempts.length === 0) return null;
  // Newest last in the input; the newest are the ones worth the space.
  const listed = attempts
    .slice(-MAX_LISTED_ATTEMPTS)
    .map((attempt) => `${attempt.remedy} ${attempt.outcome}: ${attempt.detail}`);
  const older = attempts.length - MAX_LISTED_ATTEMPTS;
  return `Tried: ${listed.join("; ")}${older > 0 ? ` (and ${older} earlier)` : ""}.`;
}

function withLink(
  input: RemediationNotificationBase,
): Pick<RemediationNotificationData, "agentId" | "workspaceId"> {
  return {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

interface BuildRemediationEscalatedPayloadInput extends RemediationNotificationBase {
  summary: string;
  attempts: readonly RemediationNotificationAttempt[];
  /**
   * Why the ladder stopped: the agent's report line, or the reason no agent ran ("escalation is
   * disabled", "the remedy is in dry run").
   */
  outcome: string;
}

/**
 * Rung 3. Says what is wrong, what rung 1 tried, and how rung 2 ended, so the person does not
 * have to open anything to know whether it is theirs to fix. Built server-side in English and
 * sent verbatim, like every other push payload in this package.
 */
export function buildRemediationEscalatedNotificationPayload(
  input: BuildRemediationEscalatedPayloadInput,
): RemediationNotificationPayload {
  const parts = [input.summary.trim(), formatAttempts(input.attempts), input.outcome.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return {
    title: `Needs you: ${input.title}`,
    body: parts.join(" "),
    data: {
      serverId: input.serverId,
      reason: "remediation_escalated",
      key: input.key,
      kind: input.kind,
      ...withLink(input),
    },
  };
}

export type RemediationRecordEvent = "opened" | "agent_started" | "fixed" | "resolved";

interface BuildRemediationRecordPayloadInput extends RemediationNotificationBase {
  event: RemediationRecordEvent;
  /** One line: the summary on open, the agent id on start, the report on FIXED, the attempts on resolve. */
  detail: string;
}

const RECORDS: Record<
  RemediationRecordEvent,
  { prefix: string; reason: RemediationNotificationReason }
> = {
  opened: { prefix: "Handling", reason: "remediation_opened" },
  agent_started: { prefix: "Agent working on", reason: "remediation_agent_started" },
  fixed: { prefix: "Fixed", reason: "remediation_fixed" },
  resolved: { prefix: "Cleared", reason: "remediation_resolved" },
};

/** The ledger-only entries: an episode's open, its agent, a FIXED report, and its close. */
export function buildRemediationRecordNotificationPayload(
  input: BuildRemediationRecordPayloadInput,
): RemediationNotificationPayload {
  const record = RECORDS[input.event];
  return {
    title: `${record.prefix}: ${input.title}`,
    body: input.detail.trim(),
    data: {
      serverId: input.serverId,
      reason: record.reason,
      key: input.key,
      kind: input.kind,
      ...withLink(input),
    },
  };
}

/** For the resolve record: the attempts in one line, or a note that rung 1 had nothing to do. */
export function describeRemediationAttempts(
  attempts: readonly RemediationNotificationAttempt[],
): string {
  return formatAttempts(attempts) ?? "No remedy ran.";
}
