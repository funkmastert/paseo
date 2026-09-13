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
    expect(row?.annotation).toEqual({ agentLabel: "Backend worker" });
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
    expect(sessionRow?.annotation).toEqual({ agentLabel: "Leader agent" });
    expect(model.hasData).toBe(true);
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
