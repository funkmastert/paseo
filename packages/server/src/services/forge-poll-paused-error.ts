/**
 * Thrown by a forge adapter's identity-based status read when the shared poll grid has paused
 * that host (a prior rate-limit response). Distinct from a generic command failure so a caller
 * can map it to a typed, non-alarming error instead of a red "failed" state.
 */
export class ForgePollPausedError extends Error {
  readonly resumeAtMs: number;

  constructor(resumeAtMs: number) {
    super(`Forge polling paused until ${new Date(resumeAtMs).toISOString()}`);
    this.name = "ForgePollPausedError";
    this.resumeAtMs = resumeAtMs;
  }
}
