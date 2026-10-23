/**
 * Pure per-server connection state machine for the MCP gateway (KTD9's core
 * data structure). No I/O, no SDK types — `gateway.ts` drives this with
 * events derived from real connection attempts so the transition rules are
 * testable without a network.
 *
 * disabled --enable--> connecting --connected--> connected
 *                          |--needsAuth--> needs-auth <--refreshFailed-- connected
 *                          |--connectionFailed--> error --retry--> connecting
 *          needs-auth --authCompleted--> connecting
 *          (any status) --disable--> disabled
 */

export type McpGatewayServerStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "needs-auth"
  | "error";

export interface McpGatewayServerState {
  readonly status: McpGatewayServerStatus;
  readonly error?: string;
  readonly lastChangedAt: number;
}

export type McpGatewayServerEvent =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "connected" }
  | { type: "needsAuth" }
  | { type: "connectionFailed"; error: string }
  | { type: "refreshFailed" }
  | { type: "authCompleted" }
  | { type: "retry" };

export class InvalidMcpGatewayTransitionError extends Error {
  constructor(
    public readonly status: McpGatewayServerStatus,
    public readonly event: McpGatewayServerEvent["type"],
  ) {
    super(`Cannot apply MCP gateway event "${event}" to a server in status "${status}"`);
    this.name = "InvalidMcpGatewayTransitionError";
  }
}

export function createDisabledServerState(now: number = Date.now()): McpGatewayServerState {
  return { status: "disabled", lastChangedAt: now };
}

export function applyServerEvent(
  state: McpGatewayServerState,
  event: McpGatewayServerEvent,
  now: number = Date.now(),
): McpGatewayServerState {
  if (event.type === "disable") {
    return state.status === "disabled" ? state : { status: "disabled", lastChangedAt: now };
  }

  switch (state.status) {
    case "disabled":
      if (event.type === "enable") {
        return { status: "connecting", lastChangedAt: now };
      }
      break;
    case "connecting":
      if (event.type === "connected") {
        return { status: "connected", lastChangedAt: now };
      }
      if (event.type === "needsAuth") {
        return { status: "needs-auth", lastChangedAt: now };
      }
      if (event.type === "connectionFailed") {
        return { status: "error", error: event.error, lastChangedAt: now };
      }
      break;
    case "connected":
      if (event.type === "refreshFailed" || event.type === "needsAuth") {
        return { status: "needs-auth", lastChangedAt: now };
      }
      if (event.type === "connectionFailed") {
        return { status: "error", error: event.error, lastChangedAt: now };
      }
      break;
    case "needs-auth":
      if (event.type === "authCompleted") {
        return { status: "connecting", lastChangedAt: now };
      }
      break;
    case "error":
      if (event.type === "retry") {
        return { status: "connecting", lastChangedAt: now };
      }
      break;
  }

  throw new InvalidMcpGatewayTransitionError(state.status, event.type);
}
