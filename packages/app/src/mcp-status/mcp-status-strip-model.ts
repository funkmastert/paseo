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
  /** The agent's provider — the account its session loaded this server under. */
  provider: string;
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

/**
 * What pressing a row does. `authenticate` runs the daemon's OAuth flow for a brokered server;
 * `adopt` asks the daemon to broker a session-reported server first (reading the reporting
 * agent's own MCP config) and then sign in; `openClaudeAi` opens claude.ai's connector settings,
 * the only place a claude.ai connector can be authorized. Absent when nothing can be done.
 */
export type McpStatusRowAction = "authenticate" | "adopt" | "openClaudeAi";

export interface McpStatusRowAnnotation {
  /** Label of the first agent that reported this server unhealthy. */
  agentLabel: string;
  /** Id of that agent — the adopt action reads its config dir and project for the definition. */
  agentId: string;
  /** That agent's provider, which is the account any adopt failure will be about. */
  agentProvider: string;
  /** Distinct agents reporting it. */
  reporterCount: number;
  /**
   * Distinct providers among the reporters, sorted. One provider means one account, and the
   * count of agents that happened to load a broken server is not the story — the account is.
   */
  providerIds: string[];
}

/**
 * The daemon's answer to the last action on a row. `reason` is its machine-readable cause
 * (docs/mcp-gateway.md); a daemon that predates it sends none and the row falls back to the
 * `error` sentence. `remedyCommand` is something the person runs on the host, never a Paseo
 * action — a row that has one is a row whose button cannot help.
 */
export interface McpStatusActionFailure {
  reason: string | null;
  /** Host specifics the client composes its own instruction from — never product copy. */
  remedyCommand: string | null;
  remedyPath: string | null;
  remedyRedirectUrl: string | null;
  error: string;
}

/**
 * Causes that pressing the button again cannot clear — the host's configuration has to change
 * first. The daemon marks these; a reason it does not know, and a daemon too old to send one,
 * both stay actionable, because the app must not withdraw an action on a guess.
 *
 * `server_rejected` and `server_unreachable` are deliberately absent: an upstream that is down
 * or refusing right now may not be in a minute, and taking away the only way to find out is
 * worse than a button that sometimes fails again.
 */
const TERMINAL_FAILURE_REASONS: ReadonlySet<string> = new Set([
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
]);

export function isTerminalActionFailure(failure: McpStatusActionFailure | undefined): boolean {
  return failure?.reason ? TERMINAL_FAILURE_REASONS.has(failure.reason) : false;
}

/** One rendered row — a brokered server (`sessionOnly: false`) or a session-only report with
 * no matching global row (`sessionOnly: true`, KTD10's "no home" fallback for AE3). */
export interface McpStatusRow {
  key: string;
  name: string;
  tone: ProviderUsageTone;
  statusKey: McpStatusRowStatusKey;
  critical: boolean;
  action?: McpStatusRowAction;
  error?: string;
  /** Set when a session reported trouble with this server too — "reported by <agent>". */
  annotation?: McpStatusRowAnnotation;
  /** The last failed attempt on this row, which decides its explanation and its action. */
  failure?: McpStatusActionFailure;
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
    agentId: first.agentId,
    agentProvider: first.provider,
    reporterCount: new Set(reports.map((report) => report.agentId)).size,
    providerIds: [...new Set(reports.map((report) => report.provider))].sort(),
  };
}

const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";

/** claude.ai connectors live on the Claude account, so the daemon can never broker them. */
export function isClaudeAiConnectorName(name: string): boolean {
  return name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX);
}

function sessionOnlyActionFor(input: {
  name: string;
  canAdopt: boolean;
  failure: McpStatusActionFailure | undefined;
}): McpStatusRowAction | undefined {
  if (isClaudeAiConnectorName(input.name)) return "openClaudeAi";
  if (!input.canAdopt) return undefined;
  // Until it has been tried, adopt is worth offering: nothing before the attempt knows whether
  // the daemon can read that server's definition. Once the daemon has named a cause retrying
  // cannot clear, the button would only fail again, so the row explains instead.
  return isTerminalActionFailure(input.failure) ? undefined : "adopt";
}

/**
 * Whether naming who reported this server tells the reader anything. On a row the gateway
 * already calls unhealthy, it does not: the status and its action say everything, and the
 * reporters are a tally of who noticed. On a row the gateway thinks is fine, the reports are
 * the only evidence anything is wrong, so they stay.
 */
export function showsReporterProvenance(row: McpStatusRow): boolean {
  if (!row.annotation) return false;
  return row.sessionOnly || (row.statusKey !== "needsAuth" && row.statusKey !== "error");
}

function isUnhealthyRow(row: McpStatusRow): boolean {
  return row.tone === "warning" || row.tone === "danger";
}

/**
 * Pure derivation of the strip's rows and collapsed summary from the daemon's server snapshot
 * plus any per-agent init-reported statuses (KTD10). Never drops a session-reported failure
 * (AE3): a report for a known server becomes an annotation on that row; reports for an
 * unknown (non-brokered) server collapse into one row per server name, annotated with the
 * accounts that reported it — never one row per agent, which with a dozen workers all loading
 * the same broken user-scope server read as a wall of duplicate notifications. A row carries an
 * `action` only while that action could still do something: `canAdopt` is the daemon's
 * `mcpGatewayAdopt` feature flag, and a `failure` the daemon called terminal withdraws it.
 */
export function buildMcpStatusStripModel(input: {
  servers: McpStatusServerEntry[];
  sessionReports: McpStatusSessionReport[];
  canAdopt?: boolean;
  /** The last failed action per server name, keyed as the strip records them. */
  failures?: Record<string, McpStatusActionFailure>;
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
      // Same withdrawal rule as adopt: an authenticate button the daemon already said cannot
      // work teaches the reader the strip is guessing.
      ...(isUnhealthy(server.status) && !isTerminalActionFailure(input.failures?.[server.name])
        ? { action: "authenticate" as const }
        : {}),
      ...(server.error !== undefined ? { error: server.error } : {}),
      ...(annotation ? { annotation } : {}),
      ...(input.failures?.[server.name] ? { failure: input.failures[server.name] } : {}),
      sessionOnly: false,
    };
  });

  const sessionOnlyRows: McpStatusRow[] = [];
  for (const [serverName, reports] of unhealthyReportsByServer) {
    if (serverNames.has(serverName)) continue;
    const annotation = annotationFor(reports);
    if (!annotation) continue;
    const failure = input.failures?.[serverName];
    const action = sessionOnlyActionFor({
      name: serverName,
      canAdopt: input.canAdopt ?? false,
      failure,
    });
    sessionOnlyRows.push({
      key: `session:${serverName}`,
      name: serverName,
      tone: "warning",
      statusKey: "sessionReported",
      critical: false,
      ...(action ? { action } : {}),
      annotation,
      ...(failure ? { failure } : {}),
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
