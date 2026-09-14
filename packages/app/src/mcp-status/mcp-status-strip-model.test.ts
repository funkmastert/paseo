import { describe, expect, it } from "vitest";
import {
  buildMcpStatusStripModel,
  deriveMcpStatusTone,
  type McpStatusServerEntry,
  type McpStatusSessionReport,
} from "./mcp-status-strip-model";

function server(overrides: Partial<McpStatusServerEntry> & { name: string }): McpStatusServerEntry {
  return {
    status: "connected",
    critical: false,
    lastChangedAt: 1,
    ...overrides,
  };
}

function report(overrides: Partial<McpStatusSessionReport> & { serverName: string }) {
  return {
    agentId: "agent-1",
    agentLabel: "Worker agent",
    status: "failed",
    ...overrides,
  } satisfies McpStatusSessionReport;
}

describe("deriveMcpStatusTone", () => {
  it("maps every gateway status to its tone, keeping connecting neutral", () => {
    expect(deriveMcpStatusTone("connected")).toBe("ok");
    expect(deriveMcpStatusTone("needs-auth")).toBe("warning");
    expect(deriveMcpStatusTone("error")).toBe("danger");
    // Neutral, not "warning" — connecting is an expected transient state, distinct from
    // needs-auth/error (KTD10).
    expect(deriveMcpStatusTone("connecting")).toBe("default");
    expect(deriveMcpStatusTone("disabled")).toBe("default");
  });
});

describe("buildMcpStatusStripModel", () => {
  it("reports no data when there are no servers and no session reports", () => {
    const model = buildMcpStatusStripModel({ servers: [], sessionReports: [] });
    expect(model.hasData).toBe(false);
    expect(model.rows).toEqual([]);
    expect(model.collapsed.hasIssues).toBe(false);
  });

  it("orders critical-unhealthy servers before other issues before healthy servers", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "github", status: "needs-auth", critical: false }),
        server({ name: "notion", status: "connected" }),
        server({ name: "zeeq", status: "error", critical: true }),
        server({ name: "agent-gateway", status: "needs-auth", critical: true }),
      ],
      sessionReports: [],
    });

    expect(model.rows.map((row) => row.name)).toEqual([
      "agent-gateway",
      "zeeq",
      "github",
      "notion",
    ]);
  });

  it("summarizes the collapsed row by naming unhealthy critical servers only", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "zeeq", status: "needs-auth", critical: true }),
        server({ name: "github", status: "needs-auth", critical: false }),
        server({ name: "notion", status: "connected" }),
      ],
      sessionReports: [],
    });

    expect(model.collapsed.unhealthyCriticalNames).toEqual(["zeeq"]);
    expect(model.collapsed.tone).toBe("warning");
    expect(model.collapsed.hasIssues).toBe(true);
  });

  it("escalates the collapsed tone to danger when a critical server errors", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "zeeq", status: "error", critical: true }),
        server({ name: "github", status: "needs-auth", critical: false }),
      ],
      sessionReports: [],
    });

    expect(model.collapsed.tone).toBe("danger");
  });

  it("keeps the collapsed tone ok when every server is healthy", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "notion", status: "connected" })],
      sessionReports: [],
    });

    expect(model.collapsed.tone).toBe("ok");
  });

  it("annotates the matching global row when a session reports the same server unhealthy", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "github", status: "connected" })],
      sessionReports: [report({ serverName: "github", agentLabel: "Backend worker" })],
    });

    const row = model.rows.find((candidate) => candidate.name === "github");
    expect(row?.annotation).toEqual({ agentLabel: "Backend worker", reporterCount: 1 });
    expect(row?.canAuth).toBe(false);
  });

  it("never drops a session-reported stdio failure with no matching global server (AE3)", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "github", status: "connected" })],
      sessionReports: [report({ serverName: "local-fs-tool", agentLabel: "Leader agent" })],
    });

    const sessionRow = model.rows.find((candidate) => candidate.name === "local-fs-tool");
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.sessionOnly).toBe(true);
    expect(sessionRow?.canAuth).toBe(false);
    expect(sessionRow?.annotation).toEqual({ agentLabel: "Leader agent", reporterCount: 1 });
    expect(model.hasData).toBe(true);
  });

  it("collapses many agents reporting the same unknown server into one row with a count", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "biblio", agentId: "agent-1", agentLabel: "Worker 1" }),
        report({ serverName: "biblio", agentId: "agent-2", agentLabel: "Worker 2" }),
        report({ serverName: "biblio", agentId: "agent-3", agentLabel: "Worker 3" }),
        report({ serverName: "agent-gateway", agentId: "agent-1", agentLabel: "Worker 1" }),
      ],
    });

    expect(model.rows.map((row) => row.name)).toEqual(["agent-gateway", "biblio"]);
    const biblio = model.rows.find((row) => row.name === "biblio");
    expect(biblio?.key).toBe("session:biblio");
    expect(biblio?.annotation).toEqual({ agentLabel: "Worker 1", reporterCount: 3 });
    expect(biblio?.canAuth).toBe(false);
  });

  it("counts distinct agents, not repeated reports, on a matching global row", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "zeeq", status: "needs-auth", critical: true })],
      sessionReports: [
        report({ serverName: "zeeq", agentId: "agent-1", agentLabel: "Worker 1" }),
        report({ serverName: "zeeq", agentId: "agent-1", agentLabel: "Worker 1" }),
        report({ serverName: "zeeq", agentId: "agent-2", agentLabel: "Worker 2" }),
      ],
    });

    const row = model.rows.find((candidate) => candidate.name === "zeeq");
    expect(row?.annotation).toEqual({ agentLabel: "Worker 1", reporterCount: 2 });
    expect(row?.canAuth).toBe(true);
    expect(model.rows).toHaveLength(1);
  });

  it("names session-reported servers in the collapsed summary when the gateway has none", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "biblio", agentId: "agent-1" }),
        report({ serverName: "claude.ai Robinhood", agentId: "agent-2", status: "needs-auth" }),
      ],
    });

    // Previously the collapsed row read "MCP servers connected" here — no critical gateway
    // server was unhealthy because there were no gateway servers at all.
    expect(model.collapsed.unhealthyCriticalNames).toEqual([]);
    expect(model.collapsed.issueNames).toEqual(["biblio", "claude.ai Robinhood"]);
    expect(model.collapsed.tone).toBe("warning");
    expect(model.collapsed.hasIssues).toBe(true);
  });

  it("prefers unhealthy critical names over other issues in the collapsed summary", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "zeeq", status: "needs-auth", critical: true }),
        server({ name: "github", status: "needs-auth", critical: false }),
      ],
      sessionReports: [report({ serverName: "biblio" })],
    });

    expect(model.collapsed.issueNames).toEqual(["zeeq"]);
  });

  it("names non-critical unhealthy servers when no critical server is unhealthy", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "zeeq", status: "connected", critical: true }),
        server({ name: "github", status: "needs-auth", critical: false }),
      ],
      sessionReports: [],
    });

    expect(model.collapsed.issueNames).toEqual(["github"]);
    expect(model.collapsed.hasIssues).toBe(true);
  });

  it("reports no issue names when every server is healthy", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "notion", status: "connected" })],
      sessionReports: [],
    });

    expect(model.collapsed.issueNames).toEqual([]);
    expect(model.collapsed.hasIssues).toBe(false);
  });

  it("does not surface a session report that reads as healthy", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [report({ serverName: "local-fs-tool", status: "connected" })],
    });

    expect(model.hasData).toBe(false);
    expect(model.rows).toEqual([]);
  });
});
