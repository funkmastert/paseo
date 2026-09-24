import type { AccountPoolProviderEntry } from "../agent/account-pool-providers.js";
import type { ProviderHealth } from "../agent-done-janitor.js";
import type { RemediationObservation } from "./contract.js";

/** Evidence past this is cut: the agent can re-derive detail, but a huge prompt costs every turn. */
export const MAX_EVIDENCE_CHARS = 8 * 1024;

export type RemediationReport =
  | { outcome: "fixed"; line: string }
  | { outcome: "not-fixed"; line: string };

const REPORT_LINE = /^REMEDIATION: (FIXED|NOT_FIXED) — \S.*$/;

/**
 * The agent's last non-empty line, read strictly. Anything but an exact `REMEDIATION: FIXED — …`
 * is not fixed: a person hears about a condition the agent could not vouch for, never the reverse.
 */
export function parseRemediationReport(finalText: string | null | undefined): RemediationReport {
  const lastLine =
    (finalText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) ?? "";
  const match = REPORT_LINE.exec(lastLine);
  if (!match) {
    return {
      outcome: "not-fixed",
      line: lastLine
        ? `The agent ended without a REMEDIATION line; its last line was: ${truncate(lastLine, 200)}`
        : "The agent ended without a REMEDIATION line.",
    };
  }
  return { outcome: match[1] === "FIXED" ? "fixed" : "not-fixed", line: lastLine };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function truncateEvidence(evidence: string): string {
  if (evidence.length <= MAX_EVIDENCE_CHARS) return evidence;
  const dropped = evidence.length - MAX_EVIDENCE_CHARS;
  return `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n… (${dropped} more characters cut)`;
}

export function buildRemediationAgentTitle(observation: RemediationObservation): string {
  return `Remediate: ${observation.title}`;
}

/**
 * The remediation agent's whole brief. The monitor's `escalation.task` is the job; everything
 * else here is the same for every condition: what rung 1 already found and did, the limits, and
 * the one-line report the ladder parses.
 */
export function buildRemediationPrompt(input: {
  observation: RemediationObservation;
  task: string;
  timeoutMinutes: number;
  budgetTokens: number;
}): string {
  const { observation } = input;
  const attempts = observation.attempts ?? [];
  const attemptLines =
    attempts.length === 0
      ? ["- none: no deterministic remedy ran"]
      : attempts.map(
          (attempt) => `- ${attempt.at} ${attempt.remedy} (${attempt.outcome}): ${attempt.detail}`,
        );
  const evidence = observation.evidence?.trim()
    ? truncateEvidence(observation.evidence.trim())
    : "(the monitor sent no evidence)";

  return [
    "You are a remediation agent started by the Paseo daemon's remediation ladder. A monitor found a condition its deterministic remedy could not clear. You are the one attempt before a person is told.",
    "",
    `## Condition: ${observation.title}`,
    `Kind: ${observation.kind}. Key: ${observation.key}.`,
    observation.summary,
    "",
    "## Evidence the monitor collected",
    "```",
    evidence,
    "```",
    "",
    "## What the deterministic remedy already tried, oldest first",
    ...attemptLines,
    "",
    "## Your task",
    input.task,
    "",
    "## Limits",
    "- Stay inside the task. Do not start unrelated cleanup or improvements.",
    "- Do not push to any shared company forge (Wondergit, the wonderlydotcom GitHub org, or any other shared remote).",
    "- Never restart the Paseo daemon, and never edit ~/.paseo/config.json.",
    "- Never touch another agent's worktree except as the task says.",
    "- Never delete uncommitted work. If something you would delete holds uncommitted changes, stop and report NOT_FIXED.",
    `- You have ${input.timeoutMinutes} minutes and about ${input.budgetTokens.toLocaleString("en-US")} tokens. Past either, you are cancelled and a person is told.`,
    "- If you cannot fix it safely, say so. A NOT_FIXED report is a good outcome; a risky fix is not.",
    "",
    "## Report",
    "End your final message with exactly one line, and nothing after it:",
    "REMEDIATION: FIXED — <one line: what you did and how you confirmed the condition cleared>",
    "or",
    "REMEDIATION: NOT_FIXED — <one line: what is wrong and what a person has to do>",
    "Any other ending counts as NOT_FIXED.",
  ].join("\n");
}

/**
 * Why no agent can run, or null when one can. Escalation is impossible when every account the
 * classifier could place the agent on is dead or capped: for a claude-family provider with an
 * account pool, every enabled pooled account; otherwise the provider itself.
 */
export async function findEscalationAccountBlocker(input: {
  provider: string;
  poolEntries: readonly AccountPoolProviderEntry[];
  getHealth: (provider: string) => Promise<ProviderHealth>;
}): Promise<string | null> {
  const pooled = input.poolEntries.filter((entry) => entry.enabled).map((e) => e.providerId);
  const candidates =
    pooled.length > 0 && input.poolEntries.some((e) => e.providerId === input.provider)
      ? pooled
      : [input.provider];
  const reasons: string[] = [];
  for (const provider of candidates) {
    const health = await input.getHealth(provider);
    if (health.askable) return null;
    reasons.push(health.reason);
  }
  return `no usable account: ${reasons.join("; ")}`;
}
