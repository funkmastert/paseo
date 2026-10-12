/**
 * Typed refusal for the Codex child guard (review finding #13), following `AgentProviderMoveError`
 * (provider-move.ts): structured metadata instead of a message a caller has to regex, so
 * failover/retry/UI code can tell "the guard refused this" apart from any other create failure.
 */
import type { CodexGuardHealthStatus } from "./codex-guard-health.js";

export type CodexChildGuardErrorCode =
  | "health_unhealthy"
  | "mode_change_refused"
  | "provider_move_refused";

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
