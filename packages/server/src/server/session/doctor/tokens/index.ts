import type { DoctorCheck, DoctorContext } from "../context.js";
import { cacheCheck } from "./cache.js";
import { hooksCheck } from "./hooks.js";
import { memoryCheck } from "./memory.js";
import { modelCheck } from "./model.js";
import { scheduledCheck } from "./scheduled.js";
import { subagentsCheck } from "./subagents.js";
import { toolsCheck } from "./tools.js";
import { rowToFinding, unknownRow, type TokenAuditCheck, type TokenAuditRow } from "./types.js";

export * from "./types.js";

/** One check per audit item, in the order the table prints them. */
export const TOKEN_AUDIT_CHECKS: readonly TokenAuditCheck[] = [
  memoryCheck,
  toolsCheck,
  modelCheck,
  hooksCheck,
  subagentsCheck,
  scheduledCheck,
  cacheCheck,
];

function timeoutFor(check: TokenAuditCheck, ctx: DoctorContext): number {
  return typeof check.timeoutMs === "function" ? check.timeoutMs(ctx) : check.timeoutMs;
}

/** One item under its own deadline. A slow or failing item is one UNKNOWN row and nothing else. */
export async function runTokenAuditCheck(
  check: TokenAuditCheck,
  ctx: DoctorContext,
): Promise<TokenAuditRow[]> {
  const timeoutMs = timeoutFor(check, ctx);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([check.measure(ctx, ctx.now() + timeoutMs), timedOut]);
    return result === "timeout"
      ? [
          unknownRow(
            check.item,
            `${check.item}:timeout`,
            `${check.item} audit did not finish`,
            `did not finish within ${Math.round(timeoutMs / 1000)}s`,
          ),
        ]
      : result;
  } catch (error) {
    return [
      unknownRow(
        check.item,
        `${check.item}:failed`,
        `${check.item} audit failed`,
        error instanceof Error ? error.message : String(error),
      ),
    ];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs all seven items concurrently. Never throws, never writes. */
export async function runTokenAudit(
  ctx: DoctorContext,
  checks: readonly TokenAuditCheck[] = TOKEN_AUDIT_CHECKS,
): Promise<TokenAuditRow[]> {
  return (await Promise.all(checks.map((check) => runTokenAuditCheck(check, ctx)))).flat();
}

/**
 * The same checks as doctor checks, category `tokens`. They are not in `DOCTOR_CHECKS`: a run
 * streams gigabytes of transcripts and spawns `claude`, so a plain `paseo doctor` stays quick and
 * `paseo doctor --tokens` asks for them.
 */
export const TOKEN_DOCTOR_CHECKS: readonly DoctorCheck[] = TOKEN_AUDIT_CHECKS.map((check) => ({
  id: check.id,
  category: "tokens",
  timeoutMs: check.timeoutMs,
  async run(ctx) {
    return (await runTokenAuditCheck(check, ctx)).map(rowToFinding);
  },
}));
