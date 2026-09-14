import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import {
  stripMcpGatewayServers,
  withRuntimeMcpGatewayServers,
  withRuntimePaseoMcpServer,
} from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

describe("withRuntimeMcpGatewayServers", () => {
  test("injects brokered entries with a bearer header and flips the gateway-enabled flag", () => {
    const result = withRuntimeMcpGatewayServers({
      config: BASE_CONFIG,
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github", "zeeq"],
      gatewayAuthToken: "gw-token",
    });

    expect(result.mcpGatewayEnabled).toBe(true);
    // Overlay is the default mode — see docs/mcp-gateway.md "Session injection".
    expect(result.mcpGatewaySessionMode).toBe("overlay");
    expect(result.mcpServers).toEqual({
      github: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/gateway/github",
        headers: { Authorization: "Bearer gw-token" },
      },
      zeeq: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/gateway/zeeq",
        headers: { Authorization: "Bearer gw-token" },
      },
    });
  });

  test("passes an explicit strict session mode through to the launch config", () => {
    const result = withRuntimeMcpGatewayServers({
      config: BASE_CONFIG,
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github"],
      gatewayAuthToken: "gw-token",
      sessionMode: "strict",
    });

    expect(result.mcpGatewaySessionMode).toBe("strict");
  });

  test("omits the header when no gateway token is available", () => {
    const result = withRuntimeMcpGatewayServers({
      config: BASE_CONFIG,
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github"],
      gatewayAuthToken: null,
    });

    expect(result.mcpServers?.github).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/gateway/github",
    });
  });

  test("does not inject and does not flip the flag when disabled (R10 byte-identical)", () => {
    const result = withRuntimeMcpGatewayServers({
      config: BASE_CONFIG,
      enabled: false,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github"],
      gatewayAuthToken: "gw-token",
    });

    expect(result).toEqual(BASE_CONFIG);
  });

  test("does not inject when the gateway's base URL isn't known yet", () => {
    const result = withRuntimeMcpGatewayServers({
      config: BASE_CONFIG,
      enabled: true,
      gatewayBaseUrl: null,
      serverNames: ["github"],
      gatewayAuthToken: "gw-token",
    });

    expect(result).toEqual(BASE_CONFIG);
  });

  test("stored config wins on name collision with a brokered entry", () => {
    const configWithOverride: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpServers: {
        github: { type: "stdio", command: "my-local-github-shim" },
      },
    };

    const result = withRuntimeMcpGatewayServers({
      config: configWithOverride,
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github"],
      gatewayAuthToken: "gw-token",
    });

    expect(result.mcpServers?.github).toEqual({
      type: "stdio",
      command: "my-local-github-shim",
    });
  });

  test("strips a previously-injected brokered entry from the input before re-injecting", () => {
    const configWithStaleEntry: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpServers: {
        stale: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/gateway/stale",
          headers: { Authorization: "Bearer old-token" },
        },
      },
    };

    const result = withRuntimeMcpGatewayServers({
      config: configWithStaleEntry,
      enabled: true,
      gatewayBaseUrl: "http://127.0.0.1:6767",
      serverNames: ["github"],
      gatewayAuthToken: "gw-token",
    });

    expect(result.mcpServers?.stale).toBeUndefined();
    expect(result.mcpServers?.github).toBeDefined();
  });
});

describe("stripMcpGatewayServers", () => {
  test("removes brokered http entries and the gateway-enabled flag", () => {
    const config: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpGatewayEnabled: true,
      mcpGatewaySessionMode: "strict",
      mcpServers: {
        github: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/gateway/github",
          headers: { Authorization: "Bearer gw-token" },
        },
        keep: { type: "stdio", command: "local-tool" },
      },
    };

    const result = stripMcpGatewayServers(config);

    expect(result.mcpGatewayEnabled).toBeUndefined();
    expect(result.mcpGatewaySessionMode).toBeUndefined();
    expect(result.mcpServers).toEqual({ keep: { type: "stdio", command: "local-tool" } });
  });

  test("drops mcpServers entirely when nothing remains", () => {
    const config: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpServers: {
        github: { type: "http", url: "http://127.0.0.1:6767/mcp/gateway/github" },
      },
    };

    const result = stripMcpGatewayServers(config);

    expect(result.mcpServers).toBeUndefined();
  });

  test("leaves a config with no gateway entries untouched", () => {
    const config: AgentSessionConfig = {
      ...BASE_CONFIG,
      mcpServers: { keep: { type: "stdio", command: "local-tool" } },
    };

    expect(stripMcpGatewayServers(config)).toEqual(config);
  });
});
