import { CLIENT_SHUTDOWN_RPC_REASON } from "../lifecycle-reasons.js";
import type { PreviousShutdown } from "./shutdown-receipt.js";

/**
 * Restart recovery's plain-language account of why the last daemon stopped, for
 * docs/restart-recovery.md's strip. `bozeo_quit` also covers a bare `kill -TERM` from a terminal:
 * the worker cannot tell a supervisor's signal from any other sender of the same signal, and
 * Bozeo's own quit path is the overwhelmingly common source of one.
 */
export type PreviousShutdownReasonCode =
  | "bozeo_quit"
  | "update"
  | "crashed"
  | "power_loss"
  | "cli_stop"
  | "unknown";

export interface PreviousShutdownInfo {
  reason: PreviousShutdownReasonCode;
  /** When it happened, if known. */
  at: string | null;
  detail?: string;
}

const SUPERVISOR_SIGNALS = new Set(["SIGTERM", "SIGINT", "Supervisor shutdown request"]);

/**
 * Maps the previous daemon's shutdown receipt (plus a cheap reboot check) to one plain-language
 * reason. A receipt that exists means the worker ran its shutdown handler, so power loss is only
 * considered when there is no receipt at all.
 */
export function describePreviousShutdown(input: {
  previous: PreviousShutdown;
  /** This boot's system boot time, e.g. `Date.now() - os.uptime() * 1000`. */
  systemBootAt: Date | null;
  /** The last heartbeat the previous daemon wrote, read before this daemon overwrites the file. */
  lastHeartbeatAt: Date | null;
}): PreviousShutdownInfo {
  const { previous } = input;

  if (previous.status === "receipt") {
    const receipt = previous.receipt;
    if (receipt.outcome === "crashed") {
      return { reason: "crashed", at: receipt.completedAt, detail: receipt.failures[0]?.error };
    }
    if (receipt.reason === "daemon_update") {
      return { reason: "update", at: receipt.completedAt };
    }
    if (receipt.reason === CLIENT_SHUTDOWN_RPC_REASON) {
      return { reason: "cli_stop", at: receipt.completedAt };
    }
    if (receipt.signal !== null && SUPERVISOR_SIGNALS.has(receipt.signal)) {
      return {
        reason: "bozeo_quit",
        at: receipt.completedAt,
        detail: receipt.outcome === "timed-out" ? "shutdown budget exhausted" : undefined,
      };
    }
    return { reason: "unknown", at: receipt.completedAt };
  }

  if (previous.status === "unreadable") {
    return { reason: "unknown", at: null, detail: previous.error };
  }

  // No receipt at all: killed outright, crashed hard, or first run. A reboot between the last
  // heartbeat and now is the one case this can still explain.
  if (
    input.systemBootAt &&
    input.lastHeartbeatAt &&
    input.systemBootAt.getTime() > input.lastHeartbeatAt.getTime()
  ) {
    return { reason: "power_loss", at: input.systemBootAt.toISOString() };
  }
  return { reason: "crashed", at: null };
}

/** The legacy `crash` | `clean` | `unknown` vocabulary, for a client older than this feature. */
export function legacyPreviousShutdownString(info: PreviousShutdownInfo): string {
  if (info.reason === "crashed") return "crash";
  if (info.reason === "unknown") return "unknown";
  return "clean";
}
