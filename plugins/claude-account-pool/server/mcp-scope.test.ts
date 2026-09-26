import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, MCP_LABEL, type RoleRecord } from "../shared/role-policy-schema";
import {
  decideMcp,
  mcpScopeLabelValue,
  readMcpGatewaySnapshot,
  type McpDecisionInput,
  type McpGatewaySnapshot,
} from "./mcp-scope";

const GATEWAY: McpGatewaySnapshot = {
  servers: [
    { name: "zeeq", critical: true },
    { name: "github", critical: false },
    { name: "notion", critical: false },
    { name: "linear", critical: false },
    { name: "figma", critical: false },
    { name: "slack", critical: false },
    { name: "agent-gateway", critical: true },
    { name: "amplitude", critical: false },
  ],
};

const worker = DEFAULT_POLICY.roles.find((role) => role.id === "worker") as RoleRecord;

function child(overrides: Partial<McpDecisionInput> = {}): McpDecisionInput {
  return { hasCaller: true, ...overrides };
}

describe("decideMcp", () => {
  it("a root keeps every server and the claude.ai connectors", () => {
    const decision = decideMcp({ hasCaller: false }, GATEWAY, worker);
    expect(decision.scoped).toBe(false);
    expect(decision.gatewayServers).toEqual(GATEWAY.servers.map((server) => server.name));
    expect(decision.claudeAiConnectors).toBe(true);
    expect(decision.reason).toMatch(/root/);
  });

  it("a child gets only the critical servers by default", () => {
    const decision = decideMcp(child(), GATEWAY, worker);
    expect(decision.scoped).toBe(true);
    expect(decision.gatewayServers).toEqual(["zeeq", "agent-gateway"]);
    expect(decision.withheldServers).toEqual(["github", "notion", "linear", "figma", "slack", "amplitude"]);
    expect(decision.claudeAiConnectors).toBe(false);
    expect(decision.grants).toEqual([
      { server: "zeeq", source: "critical" },
      { server: "agent-gateway", source: "critical" },
    ]);
  });

  it("the paseo.mcp label adds servers, in config order, and claude.ai connectors", () => {
    const decision = decideMcp(child({ labels: { [MCP_LABEL]: "slack, linear,claude.ai" } }), GATEWAY, worker);
    expect(decision.gatewayServers).toEqual(["zeeq", "linear", "slack", "agent-gateway"]);
    expect(decision.claudeAiConnectors).toBe(true);
    expect(decision.grants).toContainEqual({ server: "linear", source: "declared" });
    expect(decision.grants).toContainEqual({ server: "claude.ai", source: "declared" });
  });

  it("an unknown name in paseo.mcp never blocks and is reported", () => {
    const decision = decideMcp(child({ labels: { [MCP_LABEL]: "linear,jira" } }), GATEWAY, worker);
    expect(decision.scoped).toBe(true);
    expect(decision.gatewayServers).toContain("linear");
    expect(decision.unknownDeclaredValues).toEqual(["jira"]);
    expect(decision.reason).toMatch(/jira/);
  });

  it("paseo is always there, so naming it is not unknown", () => {
    const decision = decideMcp(child({ labels: { [MCP_LABEL]: "paseo" } }), GATEWAY, worker);
    expect(decision.unknownDeclaredValues).toBeUndefined();
  });

  it("paseo.mcp=all keeps everything", () => {
    const decision = decideMcp(child({ labels: { [MCP_LABEL]: "all" } }), GATEWAY, worker);
    expect(decision.scoped).toBe(false);
    expect(decision.claudeAiConnectors).toBe(true);
    expect(decision.reason).toMatch(/all/);
  });

  it("the role's own servers are added", () => {
    const decision = decideMcp(child(), GATEWAY, { ...worker, mcpServers: ["figma", "claude.ai"] });
    expect(decision.grants).toContainEqual({ server: "figma", source: "role" });
    expect(decision.claudeAiConnectors).toBe(true);
  });

  it("infers a server named in the title or prompt, as a whole word", () => {
    const decision = decideMcp(
      child({ title: "Fix the Linear sync", initialPrompt: "See https://github.com/org/repo/pull/12 and mcp__notion__search" }),
      GATEWAY,
      worker,
    );
    expect(decision.grants).toContainEqual({ server: "linear", source: "inferred" });
    expect(decision.grants).toContainEqual({ server: "github", source: "inferred" });
    expect(decision.grants).toContainEqual({ server: "notion", source: "inferred" });
    expect(decision.gatewayServers).not.toContain("slack");
  });

  it("does not infer a server from a longer word that contains its name", () => {
    const decision = decideMcp(child({ initialPrompt: "slacking github-actions-free code" }), GATEWAY, worker);
    expect(decision.gatewayServers).not.toContain("slack");
  });

  it("explicit is recorded over inferred for the same server", () => {
    const decision = decideMcp(
      child({ labels: { [MCP_LABEL]: "linear" }, initialPrompt: "linear" }),
      GATEWAY,
      worker,
    );
    expect(decision.grants.filter((grant) => grant.server === "linear")).toEqual([
      { server: "linear", source: "declared" },
    ]);
  });

  it("infers the claude.ai connectors from their names", () => {
    const decision = decideMcp(child({ initialPrompt: "Write it up in Claude Docs" }), GATEWAY, worker);
    expect(decision.claudeAiConnectors).toBe(true);
  });

  it("fails open to every server when the gateway list is unknown", () => {
    const decision = decideMcp(child(), undefined, worker);
    expect(decision.scoped).toBe(false);
    expect(decision.claudeAiConnectors).toBe(true);
    expect(decision.reason).toMatch(/could not be read/);
  });
});

describe("mcpScopeLabelValue", () => {
  it("records the granted gateway servers and the connectors", () => {
    const decision = decideMcp(child({ labels: { [MCP_LABEL]: "claude.ai" } }), GATEWAY, worker);
    expect(mcpScopeLabelValue(decision)).toBe("zeeq,agent-gateway,claude.ai");
  });

  it("writes none for an empty scope", () => {
    const decision = decideMcp(child(), { servers: [] }, worker);
    expect(mcpScopeLabelValue(decision)).toBe("none");
  });

  it("writes nothing for an unscoped decision", () => {
    expect(mcpScopeLabelValue(decideMcp({ hasCaller: false }, GATEWAY, worker))).toBeUndefined();
  });
});

describe("readMcpGatewaySnapshot", () => {
  it("reads remote and local servers with their critical flag", () => {
    expect(
      readMcpGatewaySnapshot({
        mcpGateway: {
          enabled: true,
          servers: { zeeq: { url: "x", critical: true }, github: { url: "y" } },
          localServers: { figma: { command: "node" } },
        },
      }),
    ).toEqual({
      servers: [
        { name: "zeeq", critical: true },
        { name: "github", critical: false },
        { name: "figma", critical: false },
      ],
    });
  });

  it("reads a disabled or missing gateway as no servers", () => {
    expect(readMcpGatewaySnapshot({})).toEqual({ servers: [] });
    expect(readMcpGatewaySnapshot({ mcpGateway: { enabled: false, servers: { a: {} } } })).toEqual({ servers: [] });
  });

  it("lists a name in both maps once", () => {
    expect(
      readMcpGatewaySnapshot({ mcpGateway: { enabled: true, servers: { figma: {} }, localServers: { figma: {} } } }),
    ).toEqual({ servers: [{ name: "figma", critical: false }] });
  });
});
