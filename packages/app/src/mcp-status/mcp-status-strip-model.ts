import type { ProviderUsageTone } from "@getpaseo/protocol/messages";

/** Mirrors `McpGatewayStatusEntrySchema`'s state machine (packages/protocol/src/messages.ts). */
export type McpServerStatus = "disabled" | "connecting" | "connected" | "needs-auth" | "error";

/** One entry from the daemon-wide `mcp_status_update` snapshot (KTD7). */
export interface McpStatusServerEntry {
  name: string;
  status: McpServerStatus;
  critical: boolean;
  lastChangedAt: number;
  error?: string;
}

/**
 * One agent's init-reported status for a server (KTD8's `AgentMcpServerStatus`, sourced from
 * the Claude SDK's `mcp_servers` init payload). `status` is whatever string the SDK reports —
 * unlike the gateway's `McpServerStatus`, it isn't a closed enum, so the model only asks
 * whether it reads as healthy ("connected") or not.
 */
export interface McpStatusSessionReport {
  agentId: string;
  agentLabel: string;
  serverName: string;
  status: string;
}

export type McpStatusRowStatusKey =
  | "connected"
  | "connecting"
  | "needsAuth"
  | "error"
  | "disabled"
  | "sessionReported";

export interface McpStatusRowAnnotation {
  /** Label of the first agent that reported this server unhealthy. */
  agentLabel: string;
  /** Distinct agents reporting it — the strip says "reported by N agents" above one. */
  reporterCount: number;
}

/** One rendered row — a brokered server (`sessionOnly: false`) or a session-only report with
 * no matching global row (`sessionOnly: true`, KTD10's "no home" fallback for AE3). */
export interface McpStatusRow {
  key: string;
  name: string;
  tone: ProviderUsageTone;
  statusKey: McpStatusRowStatusKey;
  critical: boolean;
  /** Whether the auth/re-auth action applies. Always false for session-only rows — stdio/
   * pass-through servers have no daemon-side auth flow (KTD10). */
  canAuth: boolean;
  error?: string;
  /** Set when a session reported trouble with this server too — "reported by <agent>". */
  annotation?: McpStatusRowAnnotation;
  sessionOnly: boolean;
}

export interface McpStatusCollapsedSummary {
  tone: ProviderUsageTone;
  /** Critical servers currently unhealthy (needs-auth/error) — named per the collapsed-row
   * spec in KTD10 ("aggregate dot + names of unhealthy critical servers"). */
  unhealthyCriticalNames: string[];
  /**
   * Names for the collapsed "MCP issues: …" text: the unhealthy critical servers when there are
   * any, else every unhealthy row (non-critical gateway servers, session-reported servers).
   * Empty only when nothing is unhealthy, so the collapsed row never reads "connected" while a
   * row underneath it isn't — which is exactly what happened when the gateway had no servers
   * and only session reports existed.
   */
  issueNames: string[];
  hasIssues: boolean;
}

export interface McpStatusStripModel {
  /** False when there is nothing to show at all — no servers and no session reports. */
  hasData: boolean;
  collapsed: McpStatusCollapsedSummary;
  rows: McpStatusRow[];
}

const UNHEALTHY_STATUSES = new Set<McpServerStatus>(["needs-auth", "error"]);

function isUnhealthy(status: McpServerStatus): boolean {
  return UNHEALTHY_STATUSES.has(status);
}

export function deriveMcpStatusTone(status: McpServerStatus): ProviderUsageTone {
  switch (status) {
    case "connected":
      return "ok";
    case "needs-auth":
      return "warning";
    case "error":
      return "danger";
    // `connecting` is deliberately neutral, not a warning tone — it's the expected transient
    // state right after the daemon (re)starts or an auth flow completes (KTD10).
    case "connecting":
    case "disabled":
      return "default";
    default:
      return "default";
  }
}

function statusKeyFor(status: McpServerStatus): McpStatusRowStatusKey {
  switch (status) {
    case "needs-auth":
      return "needsAuth";
    default:
      return status;
  }
}

// Critical-unhealthy first, then any other unhealthy/reported row, then healthy/neutral rows.
// Alphabetical by name within each bucket for a stable, testable order.
function rowRank(row: McpStatusRow): number {
  const unhealthy = row.statusKey === "needsAuth" || row.statusKey === "error" || row.sessionOnly;
  if (row.critical && unhealthy) return 0;
  if (unhealthy) return 1;
  return 2;
}

function sortRows(rows: McpStatusRow[]): McpStatusRow[] {
  return [...rows].sort((a, b) => {
    const rankDiff = rowRank(a) - rowRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });
}

function deriveCollapsedTone(
  servers: McpStatusServerEntry[],
  hasUnmatchedSessionIssues: boolean,
): ProviderUsageTone {
  if (servers.some((s) => s.critical && s.status === "error")) return "danger";
  if (servers.some((s) => s.critical && s.status === "needs-auth")) return "warning";
  if (servers.some((s) => s.status === "error")) return "danger";
  if (servers.some((s) => s.status === "needs-auth")) return "warning";
  if (hasUnmatchedSessionIssues) return "warning";
  if (servers.length === 0) return "default";
  if (servers.some((s) => s.status === "connecting")) return "default";
  return "ok";
}

function groupUnhealthyReportsByServer(
  reports: McpStatusSessionReport[],
): Map<string, McpStatusSessionReport[]> {
  const byServer = new Map<string, McpStatusSessionReport[]>();
  for (const report of reports) {
    if (report.status === "connected") continue;
    const bucket = byServer.get(report.serverName);
    if (bucket) {
      bucket.push(report);
    } else {
      byServer.set(report.serverName, [report]);
    }
  }
  return byServer;
}

function annotationFor(reports: McpStatusSessionReport[]): McpStatusRowAnnotation | undefined {
  const first = reports[0];
  if (!first) return undefined;
  return {
    agentLabel: first.agentLabel,
    reporterCount: new Set(reports.map((report) => report.agentId)).size,
  };
}

function isUnhealthyRow(row: McpStatusRow): boolean {
  return row.tone === "warning" || row.tone === "danger";
}

/**
 * Pure derivation of the strip's rows and collapsed summary from the daemon's server snapshot
 * plus any per-agent init-reported statuses (KTD10). Never drops a session-reported failure
 * (AE3): a report for a known server becomes an annotation on that row; reports for an
 * unknown (non-brokered) server collapse into one row per server name with a reporter count —
 * never one row per agent, which with a dozen workers all loading the same broken user-scope
 * server read as a wall of duplicate notifications — and carry no auth action.
 */
export function buildMcpStatusStripModel(input: {
  servers: McpStatusServerEntry[];
  sessionReports: McpStatusSessionReport[];
}): McpStatusStripModel {
  const serverNames = new Set(input.servers.map((server) => server.name));
  const unhealthyReportsByServer = groupUnhealthyReportsByServer(input.sessionReports);

  const serverRows: McpStatusRow[] = input.servers.map((server) => {
    const annotation = annotationFor(unhealthyReportsByServer.get(server.name) ?? []);
    return {
      key: `server:${server.name}`,
      name: server.name,
      tone: deriveMcpStatusTone(server.status),
      statusKey: statusKeyFor(server.status),
      critical: server.critical,
      canAuth: isUnhealthy(server.status),
      ...(server.error !== undefined ? { error: server.error } : {}),
      ...(annotation ? { annotation } : {}),
      sessionOnly: false,
    };
  });

  const sessionOnlyRows: McpStatusRow[] = [];
  for (const [serverName, reports] of unhealthyReportsByServer) {
    if (serverNames.has(serverName)) continue;
    const annotation = annotationFor(reports);
    if (!annotation) continue;
    sessionOnlyRows.push({
      key: `session:${serverName}`,
      name: serverName,
      tone: "warning",
      statusKey: "sessionReported",
      critical: false,
      canAuth: false,
      annotation,
      sessionOnly: true,
    });
  }

  const rows = sortRows([...serverRows, ...sessionOnlyRows]);
  const unhealthyCriticalNames = input.servers
    .filter((server) => server.critical && isUnhealthy(server.status))
    .map((server) => server.name);
  const issueNames =
    unhealthyCriticalNames.length > 0
      ? unhealthyCriticalNames
      : rows.filter(isUnhealthyRow).map((row) => row.name);

  return {
    hasData: rows.length > 0,
    collapsed: {
      tone: deriveCollapsedTone(input.servers, sessionOnlyRows.length > 0),
      unhealthyCriticalNames,
      issueNames,
      hasIssues: rows.some(isUnhealthyRow),
    },
    rows,
  };
}
