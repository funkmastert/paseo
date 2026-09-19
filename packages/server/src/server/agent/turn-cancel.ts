/**
 * How a cancelled turn is told apart from a stopped one.
 *
 * A person pressing stop and a provider session that quietly died both end a turn the same way
 * today: `turn_canceled`, lifecycle `idle`, `lastError` cleared. Only the second is a failure,
 * and the layers that route around a dead account — the failover detector reading `lastError`,
 * the account-pool health tracker reading the `agent.turn_ended` plugin outcome — can act on it
 * only if the difference survives. Kept in its own module because both the agent manager and the
 * plugin lifecycle bridge need it, and they already import each other.
 */

/** The `turn_canceled` reason a forced cancel uses when a session acknowledged an interrupt and
 * then never settled. Distinct from "interrupted", which is a person pressing stop. */
export const UNRESPONSIVE_CANCEL_REASON = "unresponsive";

/** What `lastError` carries for an unresponsive cancel, since the provider said nothing itself. */
export const UNRESPONSIVE_CANCEL_ERROR =
  "The provider session stopped responding and its turn was force-canceled.";

export function isUnresponsiveCancelReason(reason: string): boolean {
  return reason === UNRESPONSIVE_CANCEL_REASON;
}
