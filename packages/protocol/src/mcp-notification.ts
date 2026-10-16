/**
 * Push-notification builders for the MCP auth gateway (R8/R11, KTD11). Mirrors
 * token-burn-notification.ts's shape: pure builder functions, untyped JSON `data` on the
 * wire so old apps fall back to opening by `serverId` alone.
 */
export type McpGatewayNotificationReason =
  | "mcp_gateway_needs_auth"
  | "mcp_gateway_error"
  | "mcp_gateway_multi";

export interface McpGatewayNotificationData {
  [key: string]: unknown;
  serverId: string;
  name: string;
  /** Present only on the batched variant, alongside the single `name` fallback. */
  names?: string[];
  reason: McpGatewayNotificationReason;
}

export interface McpGatewayNotificationPayload {
  title: string;
  body: string;
  data: McpGatewayNotificationData;
}

export type McpGatewayNotifiableStatus = "needs-auth" | "error";

interface BuildMcpGatewayNotificationPayloadInput {
  serverId: string;
  name: string;
  status: McpGatewayNotifiableStatus;
}

/**
 * Single critical-server notification for a server that just went unhealthy (R8/R11) — the
 * gateway fires this once per unhealthy episode (needs-auth or error), never per repeat sweep.
 */
export function buildMcpGatewayNotificationPayload(
  input: BuildMcpGatewayNotificationPayloadInput,
): McpGatewayNotificationPayload {
  const title =
    input.status === "needs-auth"
      ? "MCP server needs re-authentication"
      : "MCP server is unavailable";
  const body =
    input.status === "needs-auth"
      ? `${input.name} lost its connection and needs you to sign in again.`
      : `${input.name} stopped responding.`;

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      name: input.name,
      reason: input.status === "needs-auth" ? "mcp_gateway_needs_auth" : "mcp_gateway_error",
    },
  };
}

interface BatchedMcpGatewayTransition {
  name: string;
}

interface BuildBatchedMcpGatewayNotificationPayloadInput {
  serverId: string;
  transitions: readonly BatchedMcpGatewayTransition[];
}

/**
 * Combined notification for a connect pass that pushes more than one server into an unhealthy
 * state at once — one push instead of one per server, mirroring
 * buildBatchedTokenBurnNotificationPayload.
 */
export function buildBatchedMcpGatewayNotificationPayload(
  input: BuildBatchedMcpGatewayNotificationPayloadInput,
): McpGatewayNotificationPayload {
  const first = input.transitions[0];
  if (!first) {
    throw new Error("buildBatchedMcpGatewayNotificationPayload requires at least one transition");
  }

  return {
    title: "Multiple MCP servers need attention",
    body: `${input.transitions.length} critical MCP servers lost their connection.`,
    data: {
      serverId: input.serverId,
      name: first.name,
      names: input.transitions.map((transition) => transition.name),
      reason: "mcp_gateway_multi",
    },
  };
}
