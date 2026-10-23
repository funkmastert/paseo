/**
 * Push payload sent after the daemon's event loop recovers from a wedge. The daemon cannot send
 * anything while it is wedged, so this always arrives late, and its body says how late.
 * `data.reason` is untyped JSON on the wire, like the resource-monitor and plugin reasons, so old
 * apps open the server.
 */
export interface DaemonVitalsNotificationPayload {
  title: string;
  body: string;
  data: {
    [key: string]: unknown;
    serverId: string;
    reason: "daemon_event_loop_wedged";
    wedgedForMs: number;
  };
}

interface BuildDaemonWedgedNotificationPayloadInput {
  serverId: string;
  wedgedForMs: number;
  /** `busy`: the daemon was computing. `blocked`: it was waiting in a synchronous call. */
  cause: "busy" | "blocked";
}

export function buildDaemonWedgedNotificationPayload(
  input: BuildDaemonWedgedNotificationPayloadInput,
): DaemonVitalsNotificationPayload {
  const seconds = Math.round(input.wedgedForMs / 1000);
  const what =
    input.cause === "busy" ? "it was busy computing" : "it was waiting inside a synchronous call";
  return {
    title: "Daemon was unresponsive",
    body: `The daemon was wedged for ${seconds}s and has recovered; ${what}. Nothing reached your agents through it in that time. Details are in the daemon log and diagnostics/slow-ops.jsonl.`,
    data: {
      serverId: input.serverId,
      reason: "daemon_event_loop_wedged",
      wedgedForMs: Math.round(input.wedgedForMs),
    },
  };
}
