/**
 * Typed refusal for the Codex child guard, following `AgentProviderMoveError` (provider-move.ts):
 * structured metadata instead of a message a caller has to regex, so failover/retry/UI code can
 * tell "the guard refused this" apart from any other create failure. A provider move that would
 * take a guarded child out of the codex family throws `AgentProviderMoveError` instead (its own
 * `codex_guard_protected` code), not this type -- move callers only classify on the one error
 * class their JSDoc promises.
 */
import type { CodexGuardHealthStatus } from "./codex-guard-health.js";

export type CodexChildGuardErrorCode = "health_unhealthy" | "mode_change_refused";

export class CodexChildGuardError extends Error {
  constructor(
    readonly code: CodexChildGuardErrorCode,
    readonly healthStatus: CodexGuardHealthStatus,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexChildGuardError";
  }
}
