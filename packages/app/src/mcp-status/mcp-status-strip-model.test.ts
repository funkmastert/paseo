import { describe, expect, it } from "vitest";
import {
  buildMcpStatusStripModel,
  deriveMcpStatusTone,
  isTerminalActionFailure,
  showsReporterProvenance,
  type McpStatusActionFailure,
  type McpStatusRow,
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
    provider: "claude-personal",
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
    expect(row?.annotation).toEqual({
      agentLabel: "Backend worker",
      agentId: "agent-1",
      agentProvider: "claude-personal",
      reporterCount: 1,
      providerIds: ["claude-personal"],
    });
    expect(row?.action).toBeUndefined();
  });

  it("never drops a session-reported stdio failure with no matching global server (AE3)", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "github", status: "connected" })],
      sessionReports: [report({ serverName: "local-fs-tool", agentLabel: "Leader agent" })],
    });

    const sessionRow = model.rows.find((candidate) => candidate.name === "local-fs-tool");
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.sessionOnly).toBe(true);
    expect(sessionRow?.action).toBeUndefined();
    expect(sessionRow?.annotation).toEqual({
      agentLabel: "Leader agent",
      agentId: "agent-1",
      agentProvider: "claude-personal",
      reporterCount: 1,
      providerIds: ["claude-personal"],
    });
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
    expect(biblio?.annotation).toEqual({
      agentLabel: "Worker 1",
      agentId: "agent-1",
      agentProvider: "claude-personal",
      reporterCount: 3,
      providerIds: ["claude-personal"],
    });
    expect(biblio?.action).toBeUndefined();
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
    expect(row?.annotation).toEqual({
      agentLabel: "Worker 1",
      agentId: "agent-1",
      agentProvider: "claude-personal",
      reporterCount: 2,
      providerIds: ["claude-personal"],
    });
    expect(row?.action).toBe("authenticate");
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

describe("row actions", () => {
  it("offers Authenticate on unhealthy brokered rows only", () => {
    const model = buildMcpStatusStripModel({
      servers: [
        server({ name: "zeeq", status: "needs-auth", critical: true }),
        server({ name: "github", status: "error" }),
        server({ name: "notion", status: "connected" }),
        server({ name: "linear", status: "connecting" }),
      ],
      sessionReports: [],
    });

    expect(Object.fromEntries(model.rows.map((row) => [row.name, row.action]))).toEqual({
      zeeq: "authenticate",
      github: "authenticate",
      notion: undefined,
      linear: undefined,
    });
  });

  it("offers Broker & sign in on session-reported rows when the daemon can adopt", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [report({ serverName: "agent-gateway", agentId: "agent-9" })],
      canAdopt: true,
    });

    const row = model.rows[0];
    expect(row?.action).toBe("adopt");
    expect(row?.annotation?.agentId).toBe("agent-9");
  });

  it("offers nothing on session-reported rows against an old daemon", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [report({ serverName: "agent-gateway" })],
      canAdopt: false,
    });

    expect(model.rows[0]?.action).toBeUndefined();
  });

  it("sends claude.ai connectors to claude.ai regardless of adopt support", () => {
    for (const canAdopt of [true, false]) {
      const model = buildMcpStatusStripModel({
        servers: [],
        sessionReports: [report({ serverName: "claude.ai Robinhood", status: "needs-auth" })],
        canAdopt,
      });
      expect(model.rows[0]?.action).toBe("openClaudeAi");
    }
  });

  it("labels a claude.ai connector as a per-account sign-in, not a session fault", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "claude.ai Robinhood", status: "needs-auth" }),
        report({ serverName: "sentry", status: "needs-auth" }),
      ],
    });
    const statusByName = Object.fromEntries(model.rows.map((row) => [row.name, row.statusKey]));
    expect(statusByName).toEqual({
      "claude.ai Robinhood": "claudeAiConnector",
      sentry: "sessionReported",
    });
  });
});

function failure(overrides: Partial<McpStatusActionFailure> = {}): McpStatusActionFailure {
  return {
    reason: null,
    remedyCommand: null,
    remedyPath: null,
    remedyRedirectUrl: null,
    error: "boom",
    ...overrides,
  };
}

describe("isTerminalActionFailure", () => {
  it.each([
    "gateway_disabled",
    "unknown_agent",
    "provider_has_no_config",
    "account_signed_out",
    "server_not_in_config",
    "server_is_local",
    "unknown_server",
    "static_auth",
    "no_redirect_url",
    "client_not_registered",
    "client_registration_refused",
  ])("treats %s as beyond retrying", (reason) => {
    expect(isTerminalActionFailure(failure({ reason }))).toBe(true);
  });

  it.each([
    "adopt_failed",
    "authorization_failed",
    // An upstream that is down or refusing now may not be in a minute.
    "server_rejected",
    "server_unreachable",
  ])("leaves %s retryable", (reason) => {
    expect(isTerminalActionFailure(failure({ reason }))).toBe(false);
  });

  it("never withdraws an action on a reason it does not recognise, or on none at all", () => {
    // A newer daemon naming a cause this build predates, and an older one naming none.
    expect(isTerminalActionFailure(failure({ reason: "some_future_cause" }))).toBe(false);
    expect(isTerminalActionFailure(failure())).toBe(false);
    expect(isTerminalActionFailure(undefined)).toBe(false);
  });
});

describe("buildMcpStatusStripModel action gating", () => {
  const sessionOnly = [report({ serverName: "amplitude" })];

  it("offers adopt before anything has been tried", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: sessionOnly,
      canAdopt: true,
    });

    expect(model.rows[0]?.action).toBe("adopt");
    expect(model.rows[0]?.failure).toBeUndefined();
  });

  it("withdraws adopt once the daemon names a cause signing in again cannot clear", () => {
    const signedOut = failure({
      reason: "account_signed_out",
      remedyCommand: "CLAUDE_CONFIG_DIR=/home/t/.claude-personal claude /login",
      error: "The account in /home/t/.claude-personal is not signed in",
    });
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: sessionOnly,
      canAdopt: true,
      failures: { amplitude: signedOut },
    });

    expect(model.rows[0]?.action).toBeUndefined();
    expect(model.rows[0]?.failure).toEqual(signedOut);
  });

  it("keeps adopt after a failure that retrying could clear", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: sessionOnly,
      canAdopt: true,
      failures: { amplitude: failure({ reason: "authorization_failed" }) },
    });

    expect(model.rows[0]?.action).toBe("adopt");
  });

  it("keeps sending claude.ai connectors to claude.ai, whatever adopt would have said", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [report({ serverName: "claude.ai Datadog" })],
      canAdopt: true,
      failures: { "claude.ai Datadog": failure({ reason: "server_not_in_config" }) },
    });

    expect(model.rows[0]?.action).toBe("openClaudeAi");
  });

  it("carries a failure onto a brokered row too", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "zeeq", status: "needs-auth" })],
      sessionReports: [],
      failures: { zeeq: failure({ error: "discovery failed" }) },
    });

    expect(model.rows[0]?.failure?.error).toBe("discovery failed");
    // An unrecognised reason never withdraws the gateway's own authenticate action either.
    expect(model.rows[0]?.action).toBe("authenticate");
  });
});

describe("buildMcpStatusStripModel reporter provenance", () => {
  it("records one provider when every reporter shares an account", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "amplitude", agentId: "a1", provider: "claude-personal" }),
        report({ serverName: "amplitude", agentId: "a2", provider: "claude-personal" }),
        report({ serverName: "amplitude", agentId: "a3", provider: "claude-personal" }),
      ],
    });

    expect(model.rows[0]?.annotation).toMatchObject({
      reporterCount: 3,
      providerIds: ["claude-personal"],
    });
  });

  it("records every provider, sorted, when reporters span accounts", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "amplitude", agentId: "a1", provider: "claude-personal" }),
        report({ serverName: "amplitude", agentId: "a2", provider: "claude-backup" }),
      ],
    });

    expect(model.rows[0]?.annotation).toMatchObject({
      reporterCount: 2,
      providerIds: ["claude-backup", "claude-personal"],
    });
  });

  it("names the adopting agent's own provider, which is the account a failure is about", () => {
    const model = buildMcpStatusStripModel({
      servers: [],
      sessionReports: [
        report({ serverName: "amplitude", agentId: "a1", provider: "claude-personal" }),
        report({ serverName: "amplitude", agentId: "a2", provider: "claude-backup" }),
      ],
    });

    expect(model.rows[0]?.annotation?.agentId).toBe("a1");
    expect(model.rows[0]?.annotation?.agentProvider).toBe("claude-personal");
  });
});

describe("brokered rows", () => {
  it("withdraws authenticate once the daemon says signing in cannot start", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "github", status: "needs-auth" })],
      sessionReports: [],
      failures: { github: failure({ reason: "client_not_registered" }) },
    });

    expect(model.rows[0]?.action).toBeUndefined();
    expect(model.rows[0]?.failure?.reason).toBe("client_not_registered");
  });

  it("keeps authenticate after an upstream refusal, which may not repeat", () => {
    const model = buildMcpStatusStripModel({
      servers: [server({ name: "figma", status: "needs-auth" })],
      sessionReports: [],
      failures: { figma: failure({ reason: "server_rejected" }) },
    });

    expect(model.rows[0]?.action).toBe("authenticate");
  });
});

describe("showsReporterProvenance", () => {
  function rowNamed(name: string): McpStatusRow {
    const found = buildMcpStatusStripModel({
      servers: [server({ name: "github", status: "needs-auth" }), server({ name: "zeeq" })],
      sessionReports: [
        report({ serverName: "github" }),
        report({ serverName: "zeeq" }),
        report({ serverName: "amplitude" }),
      ],
    }).rows.find((row) => row.name === name);
    if (!found) throw new Error(`no row for ${name}`);
    return found;
  }

  it("drops the reporter tally from a row whose own status already says it is broken", () => {
    expect(showsReporterProvenance(rowNamed("github"))).toBe(false);
  });

  it("keeps it where the reports are the only evidence anything is wrong", () => {
    // A brokered server the gateway calls healthy, and a server it has never heard of.
    expect(showsReporterProvenance(rowNamed("zeeq"))).toBe(true);
    expect(showsReporterProvenance(rowNamed("amplitude"))).toBe(true);
  });
});
