import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value);
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  // COMPAT(mcpStatus): mapped to daemon.read only (unlike providers_snapshot_update's
  // ["daemon.read", "hub.execute"]) — a Hub without daemon.read shouldn't see gateway status.
  test("the compaction episode list carries agents, so it is workspace.read; the totals are daemon.read", () => {
    const daemonOnly = new SessionAuthorization(["daemon.read"]);
    const workspace = new SessionAuthorization(["workspace.read"]);
    expect(daemonOnly.allowsInbound(inboundMessage("compaction.episodes.list.request"))).toBe(
      false,
    );
    expect(daemonOnly.allowsOutbound(outboundMessage("compaction.episodes.list.response"))).toBe(
      false,
    );
    expect(workspace.allowsInbound(inboundMessage("compaction.episodes.list.request"))).toBe(true);
    expect(workspace.allowsOutbound(outboundMessage("compaction.episodes.list.response"))).toBe(
      true,
    );
    expect(daemonOnly.allowsInbound(inboundMessage("compaction.episodes.summary.request"))).toBe(
      true,
    );
  });

  test("mcp_status_update requires daemon.read; hub.execute alone doesn't grant it", () => {
    expect(
      new SessionAuthorization(["hub.execute"]).allowsOutbound(
        outboundMessage("mcp_status_update"),
      ),
    ).toBe(false);
    expect(
      new SessionAuthorization(["daemon.read"]).allowsOutbound(
        outboundMessage("mcp_status_update"),
      ),
    ).toBe(true);
  });

  // U6: same daemon.manage tier as set_daemon_config/plugin management — a Hub with only
  // hub.execute (or daemon.read) can't start interactive auth for a brokered server.
  test("mcp_gateway.auth.start requires daemon.manage; daemon.read and hub.execute alone don't grant it", () => {
    expect(
      new SessionAuthorization(["hub.execute"]).allowsInbound(
        inboundMessage("mcp_gateway.auth.start.request"),
      ),
    ).toBe(false);
    expect(
      new SessionAuthorization(["daemon.read"]).allowsInbound(
        inboundMessage("mcp_gateway.auth.start.request"),
      ),
    ).toBe(false);
    expect(
      new SessionAuthorization(["daemon.manage"]).allowsInbound(
        inboundMessage("mcp_gateway.auth.start.request"),
      ),
    ).toBe(true);
    expect(
      new SessionAuthorization(["daemon.manage"]).allowsOutbound(
        outboundMessage("mcp_gateway.auth.start.response"),
      ),
    ).toBe(true);
  });

  // The setup forms write credentials and switch a server's command: configuration, so the same
  // daemon.manage tier as editing the gateway's config. Reading the form's state is gated the
  // same way, since it names which credentials are stored.
  test("mcp_gateway.setup requests require daemon.manage; viewers and a Hub alone are refused", () => {
    const requests = [
      "mcp_gateway.setup.describe.request",
      "mcp_gateway.setup.save_client.request",
      "mcp_gateway.setup.local_token.request",
    ] as const;
    const responses = [
      "mcp_gateway.setup.describe.response",
      "mcp_gateway.setup.save_client.response",
      "mcp_gateway.setup.local_token.response",
    ] as const;
    for (const type of requests) {
      for (const permission of ["hub.execute", "daemon.read", "workspace.write"] as const) {
        expect(new SessionAuthorization([permission]).allowsInbound(inboundMessage(type))).toBe(
          false,
        );
      }
      expect(new SessionAuthorization(["daemon.manage"]).allowsInbound(inboundMessage(type))).toBe(
        true,
      );
    }
    for (const type of responses) {
      expect(new SessionAuthorization(["daemon.read"]).allowsOutbound(outboundMessage(type))).toBe(
        false,
      );
      expect(
        new SessionAuthorization(["daemon.manage"]).allowsOutbound(outboundMessage(type)),
      ).toBe(true);
    }
  });

  // Starting a login on the daemon's host is administration: a Hub or a read-only client can see
  // a signed-out account but cannot sign it in.
  test("account.claude.sign_in requires daemon.manage; daemon.read and hub.execute alone don't grant it", () => {
    for (const permission of ["hub.execute", "daemon.read"] as const) {
      expect(
        new SessionAuthorization([permission]).allowsInbound(
          inboundMessage("account.claude.sign_in.request"),
        ),
      ).toBe(false);
    }
    expect(
      new SessionAuthorization(["daemon.manage"]).allowsInbound(
        inboundMessage("account.claude.sign_in.request"),
      ),
    ).toBe(true);
    expect(
      new SessionAuthorization(["daemon.manage"]).allowsOutbound(
        outboundMessage("account.claude.sign_in.response"),
      ),
    ).toBe(true);
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "send_agent_message_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "send_agent_message_response",
      "workspace.recovery.restore.response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });
});
