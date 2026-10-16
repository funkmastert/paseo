import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import { accountBudgetCheck, accountConfigCheck, accountLoginCheck } from "./accounts.js";
import { buildCheck } from "./build.js";
import { configCheck } from "./config.js";
import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import { diskCheck } from "./disk.js";
import { mcpGatewayCheck } from "./mcp-gateway.js";
import { pluginCheck } from "./plugins.js";
import { saturationCheck } from "./saturation.js";
import { skillsCheck } from "./skills.js";
import { worktreeCheck } from "./worktrees.js";

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  buildCheck,
  pluginCheck,
  configCheck,
  accountConfigCheck,
  accountLoginCheck,
  accountBudgetCheck,
  mcpGatewayCheck,
  skillsCheck,
  diskCheck,
  saturationCheck,
  worktreeCheck,
];

function timeoutFor(check: DoctorCheck, ctx: DoctorContext): number {
  return typeof check.timeoutMs === "function" ? check.timeoutMs(ctx) : check.timeoutMs;
}

async function runOne(check: DoctorCheck, ctx: DoctorContext): Promise<DoctorFinding[]> {
  const started = ctx.now();
  const timeoutMs = timeoutFor(check, ctx);
  const deadline = started + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([check.run(ctx, deadline), timedOut]);
    if (result === "timeout") {
      return [
        {
          ...finding(
            check.id,
            check.category,
            "skip",
            `${check.id}: did not finish within ${Math.round(timeoutMs / 1000)}s`,
            {
              detail:
                "This check hit its own deadline. It says nothing about the thing it was checking, and nothing else was affected.",
            },
          ),
          timedOutAfterMs: timeoutMs,
          durationMs: ctx.now() - started,
        },
      ];
    }
    const durationMs = ctx.now() - started;
    for (const f of result) f.durationMs = durationMs;
    return result;
  } catch (error) {
    return [
      {
        ...finding(check.id, check.category, "warn", `${check.id}: the check itself failed`, {
          detail: error instanceof Error ? error.message : String(error),
        }),
        durationMs: ctx.now() - started,
      },
    ];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs every check concurrently, each under its own deadline. Never throws, never writes. */
export async function runDoctorChecks(
  ctx: DoctorContext,
  checks: readonly DoctorCheck[] = DOCTOR_CHECKS,
): Promise<DoctorFinding[]> {
  const results = await Promise.all(checks.map((check) => runOne(check, ctx)));
  return results.flat();
}
