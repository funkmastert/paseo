/**
 * `agents.tokenAudit` (docs/token-audit.md). Read from `config.json` on every tick, so a change
 * applies on the next check without a restart. `windowDays`, `cwds` and `maxContextRuns` belong
 * to the checks (`session/doctor/tokens/`) and are read the same way.
 */

export interface ResolvedTokenAuditConfig {
  enabled: boolean;
  /** Days between runs. */
  intervalDays: number;
  /** Reports kept under `$PASEO_HOME/token-audit/`. */
  keep: number;
  escalation: {
    /** Off: a RED or regressed report is pushed at `notice` with no agent-written line. */
    enabled: boolean;
    budgetTokens: number;
    timeoutMinutes: number;
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveTokenAuditConfig(raw: unknown): ResolvedTokenAuditConfig {
  const config = record(raw);
  const escalation = record(config["escalation"]);
  return {
    enabled: config["enabled"] !== false,
    intervalDays: positive(config["intervalDays"], 7),
    keep: Math.floor(positive(config["keep"], 8)),
    escalation: {
      enabled: escalation["enabled"] !== false,
      budgetTokens: Math.floor(positive(escalation["budgetTokens"], 150_000)),
      timeoutMinutes: positive(escalation["timeoutMinutes"], 10),
    },
  };
}

/** `agents.tokenAudit` out of a parsed `config.json`. */
export function tokenAuditSection(rawConfig: Record<string, unknown> | null): unknown {
  return record(rawConfig?.["agents"])["tokenAudit"];
}
