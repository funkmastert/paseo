import type { JevDecideInput, JevOutcome, JevService } from "./contract.js";

/**
 * `jev.decide` bounded by a hard timeout past its own deadline, for a call site that cannot wait
 * on JEV forever even if `jev.decide` itself hangs (a bug, not a timeout it already handles).
 * Shared by feature 3b (`attention-push-triage.ts`) and feature 18 (`finish-review.ts`): both ask
 * one question from a `finally`/best-effort position and must resolve either way.
 */
export async function decideWithHardTimeout(
  jev: JevService,
  input: JevDecideInput & { hardTimeoutMs: number },
): Promise<JevOutcome | "error"> {
  const { hardTimeoutMs, ...decideInput } = input;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const decide = jev.decide(decideInput);
    const timeout = new Promise<"error">((resolve) => {
      timer = setTimeout(() => resolve("error"), hardTimeoutMs);
    });
    return await Promise.race([decide, timeout]);
  } catch {
    return "error";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
