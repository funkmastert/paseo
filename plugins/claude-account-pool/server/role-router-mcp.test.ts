import { describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { ResolvedPool } from "../shared/pool-config";
import { DEFAULT_POLICY, MCP_LABEL, MCP_SCOPE_LABEL, type RoleModelPolicy } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import type { McpGatewaySnapshot } from "./mcp-scope";
import type { ModelCatalog } from "./model-catalog";
import { createRecentAgentTypes } from "./recent-agent-types";
import { createRoleRouter, type RoleRouterOptions } from "./role-router";

type CreateAgentRequest = PluginBeforeRequests["agent.create"];
type WithLabels = CreateAgentRequest & { labels?: Record<string, string> };

const GATEWAY: McpGatewaySnapshot = {
  servers: [
    { name: "zeeq", critical: true },
    { name: "github", critical: false },
    { name: "linear", critical: false },
    { name: "agent-gateway", critical: true },
  ],
};

const fakeContext = {} as PluginHookContext;

function request(overrides: Record<string, unknown> = {}): { request: CreateAgentRequest } {
  return {
    request: {
      config: { provider: "claude", model: "claude-sonnet-5", cwd: "/tmp/work" },
      ...overrides,
    } as unknown as CreateAgentRequest,
  };
}

function childRequest(overrides: Record<string, unknown> = {}) {
  return request({ callerAgentId: "parent-1", ...overrides });
}

function options(overrides: Partial<RoleRouterOptions> = {}, policy: RoleModelPolicy = DEFAULT_POLICY): RoleRouterOptions {
  const pool: ResolvedPool = { workers: [{ providerId: "claude-work", priority: 1 }], leader: { providerId: "claude-lead" } };
  const catalog: ModelCatalog = new Map([["claude", new Set(["claude-sonnet-5", "claude-opus-5-5"])]]);
  return {
    policyCache: { get: () => policy, isMalformed: () => false, lastError: () => undefined, forceRefresh: vi.fn(), stop: vi.fn() },
    catalogCache: { get: () => catalog, getThinking: () => new Map(), forceRefresh: vi.fn(), stop: vi.fn() },
    poolCache: { get: () => ({ pool, failOpen: false }), forceRefresh: vi.fn(), stop: vi.fn() },
    health: createHealthTracker(),
    recentAgentTypes: createRecentAgentTypes(),
    mcpGatewayCache: { get: () => GATEWAY },
    ...overrides,
  } as RoleRouterOptions;
}

function settingsOf(result: CreateAgentRequest | void): Record<string, unknown> | undefined {
  return (result?.config.providerOptions as { settings?: Record<string, unknown> } | undefined)?.settings;
}

describe("createRoleRouter — MCP scope", () => {
  it("scopes a child to the critical servers, connectors off", () => {
    const result = createRoleRouter(options())(childRequest(), fakeContext) as WithLabels;

    expect(result.labels?.[MCP_SCOPE_LABEL]).toBe("zeeq,agent-gateway");
  });

  it("changes nothing but the label, so a daemon that predates scoping runs the create as before", () => {
    const withScope = createRoleRouter(options())(childRequest(), fakeContext) as WithLabels;
    const withoutScope = createRoleRouter(options({ mcpGatewayCache: { get: () => undefined } }))(
      childRequest(),
      fakeContext,
    ) as WithLabels | undefined;

    // The whole create an older daemon sees is the unscoped one plus a label it ignores.
    const { labels: scopedLabels, ...scopedRest } = withScope;
    const { labels: unscopedLabels, ...unscopedRest } = withoutScope ?? (childRequest().request as WithLabels);
    expect(scopedRest).toEqual(unscopedRest);
    expect({ ...unscopedLabels, [MCP_SCOPE_LABEL]: "zeeq,agent-gateway" }).toEqual(scopedLabels);
    expect(settingsOf(withScope)?.disableClaudeAiConnectors).toBeUndefined();
  });

  it("adds what paseo.mcp asks for, and records claude.ai when it names the connectors", () => {
    const result = createRoleRouter(options())(
      childRequest({ labels: { [MCP_LABEL]: "linear,claude.ai" } }),
      fakeContext,
    ) as WithLabels;

    expect(result.labels?.[MCP_SCOPE_LABEL]).toBe("zeeq,linear,agent-gateway,claude.ai");
  });

  it("leaves a root alone, and strips a scope label a root was handed", () => {
    const router = createRoleRouter(options());

    expect(router(request(), fakeContext)).toBeUndefined();
    const stripped = router(request({ labels: { [MCP_SCOPE_LABEL]: "zeeq" } }), fakeContext) as WithLabels;
    expect(stripped.labels).toEqual({});
  });

  it("scopes nothing without the gateway list", () => {
    const result = createRoleRouter(options({ mcpGatewayCache: { get: () => undefined } }))(
      childRequest(),
      fakeContext,
    ) as WithLabels | undefined;

    expect(result?.labels?.[MCP_SCOPE_LABEL]).toBeUndefined();
  });

  it("scopes on the model-rewrite path too", () => {
    const policy: RoleModelPolicy = {
      ...DEFAULT_POLICY,
      roles: DEFAULT_POLICY.roles.map((role) => (role.id === "worker" ? { ...role, models: ["claude-opus-5-5"] } : role)),
    };
    const result = createRoleRouter(options({}, policy))(childRequest(), fakeContext) as WithLabels;

    expect(result.config.model).toBe("claude-opus-5-5");
    expect(result.labels?.[MCP_SCOPE_LABEL]).toBe("zeeq,agent-gateway");
  });

  it("reports an unknown paseo.mcp name once per caller and value, and still creates", () => {
    const onDeclaredMcpUnknown = vi.fn();
    const router = createRoleRouter(options({ onDeclaredMcpUnknown }));

    const first = router(childRequest({ labels: { [MCP_LABEL]: "jira" } }), fakeContext) as WithLabels;
    router(childRequest({ labels: { [MCP_LABEL]: "jira" } }), fakeContext);

    expect(first.labels?.[MCP_SCOPE_LABEL]).toBe("zeeq,agent-gateway");
    expect(onDeclaredMcpUnknown).toHaveBeenCalledTimes(1);
    expect(onDeclaredMcpUnknown).toHaveBeenCalledWith({ callerAgentId: "parent-1", values: ["jira"] });
  });
});
