import type { Logger } from "pino";
import { MonitorModeLog } from "../monitor-mode-log.js";
import type { PushNotificationSender } from "../push/index.js";
import type { RemediationObservation, RemediationSink } from "../remediation/contract.js";
import type { DoctorContext } from "../session/doctor/context.js";
import { runTokenAudit } from "../session/doctor/tokens/index.js";
import {
  countSeverities,
  renderTokenAuditTable,
  type TokenAuditReport,
  type TokenAuditRow,
} from "../session/doctor/tokens/types.js";
import type { ResolvedTokenAuditConfig } from "./config.js";
import { diffReports, type ReportDiff } from "./diff.js";
import { TokenAuditReportStore, type StoredReport } from "./report-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** A restart closes and reopens every agent at once; the audit waits for that to settle. */
const FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;
/** The ladder cuts evidence at 8 KB; the worst rows go first so the cut takes GREEN ones. */
const EVIDENCE_ROWS = 40;

export const TOKEN_AUDIT_ADVICE_TASK =
  "Name the single highest-leverage change that would cut this fleet's token spend, as one line: the file, setting or command, and the measured number from the evidence that it moves. Prefer a change to a RED row or to the metric that rose. If the evidence does not support a recommendation, say which measurement is missing.";

export interface TokenAuditJobOptions {
  paseoHome: string;
  /** A fresh context per run: `rawConfig` is read at that moment, so config edits apply live. */
  buildContext: () => DoctorContext;
  readConfig: () => ResolvedTokenAuditConfig;
  sink: RemediationSink;
  getPushNotificationSender: () => PushNotificationSender;
  serverId: string;
  logger: Logger;
  now?: () => number;
  /** Tests replace the seven checks. */
  runAudit?: (ctx: DoctorContext) => Promise<TokenAuditRow[]>;
  checkIntervalMs?: number;
  firstCheckDelayMs?: number;
}

export type TokenAuditRunOutcome =
  | { kind: "recorded"; reportPath: string; counts: ReturnType<typeof countSeverities> }
  | {
      kind: "escalated";
      reportPath: string;
      episodeKey: string;
      diff: ReportDiff;
      viaAgent: boolean;
    };

/**
 * The weekly token audit (docs/token-audit.md). It runs the seven deterministic checks, stores the
 * report, and diffs it against the last one. Nothing in that path calls a model. Only a new RED or a
 * regression hands the table to the remediation ladder as an advisory episode: one small agent
 * writes the one-line recommendation and the ladder pushes it at `notice`. Otherwise the run is
 * recorded quietly.
 */
export class TokenAuditJob {
  private readonly store: TokenAuditReportStore;
  private readonly now: () => number;
  private readonly modeLog: MonitorModeLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly options: TokenAuditJobOptions) {
    this.store = new TokenAuditReportStore(`${options.paseoHome}/token-audit`);
    this.now = options.now ?? Date.now;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  start(): void {
    if (this.timer) return;
    this.reportMode();
    const check = () => {
      void this.checkDue().catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Token audit check failed");
      });
    };
    this.timer = setInterval(check, this.options.checkIntervalMs ?? CHECK_INTERVAL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.firstTimer = setTimeout(check, this.options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
    (this.firstTimer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  private reportMode(): void {
    this.modeLog.report([{ monitor: "token-audit", enabled: this.options.readConfig().enabled }]);
  }

  /** Runs when the last report is older than `intervalDays`. The report file is the schedule. */
  async checkDue(): Promise<TokenAuditRunOutcome | null> {
    this.reportMode();
    const config = this.options.readConfig();
    if (!config.enabled || this.running) return null;
    const latest = await this.store.latest();
    if (latest && this.now() - Date.parse(latest.generatedAt) < config.intervalDays * DAY_MS) {
      return null;
    }
    return this.runOnce();
  }

  async runOnce(): Promise<TokenAuditRunOutcome> {
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<TokenAuditRunOutcome> {
    const { options } = this;
    const config = options.readConfig();
    const ctx = options.buildContext();
    const rows = await (options.runAudit ?? runTokenAudit)(ctx);
    const report: TokenAuditReport = {
      version: 1,
      generatedAt: new Date(this.now()).toISOString(),
      source: "job",
      rows,
    };
    const previous = await this.store.latest();
    const diff = diffReports(previous, report);
    const episodeKey = diff.escalate
      ? `token-audit:${TokenAuditReportStore.stem(report.generatedAt)}`
      : undefined;
    const stored: StoredReport = {
      ...report,
      ...(episodeKey ? { episodeKey, reasons: diff.reasons } : {}),
    };
    const { markdownPath } = await this.store.save(stored);
    await this.store.prune(config.keep);
    await this.closePreviousEpisode(previous);

    if (!episodeKey) {
      const counts = countSeverities(rows);
      await this.record(report, markdownPath, counts);
      return { kind: "recorded", reportPath: markdownPath, counts };
    }
    const viaAgent = await this.escalate({ report, diff, episodeKey, markdownPath, config });
    return { kind: "escalated", reportPath: markdownPath, episodeKey, diff, viaAgent };
  }

  /** Last week's advisory episode ends when this week's report exists. */
  private async closePreviousEpisode(previous: StoredReport | null): Promise<void> {
    if (!previous?.episodeKey) return;
    await this.options.sink.observe({
      key: previous.episodeKey,
      kind: "token-audit",
      active: false,
      remedy: "none",
      title: "Token audit",
      summary: "A newer report replaced this one.",
    });
  }

  private async record(
    report: TokenAuditReport,
    markdownPath: string,
    counts: ReturnType<typeof countSeverities>,
  ): Promise<void> {
    await this.send(
      {
        title: `Token audit: ${counts.RED} RED, ${counts.AMBER} AMBER, nothing new`,
        body: `No new RED and nothing regressed since the last report. Report: ${markdownPath}`,
        data: { serverId: this.options.serverId, reason: "token_audit_recorded" },
      },
      { level: "record" },
    );
    this.options.logger.info(
      { markdownPath, counts, at: report.generatedAt },
      "Token audit recorded",
    );
  }

  private async escalate(input: {
    report: TokenAuditReport;
    diff: ReportDiff;
    episodeKey: string;
    markdownPath: string;
    config: ResolvedTokenAuditConfig;
  }): Promise<boolean> {
    const { report, diff, episodeKey, markdownPath, config } = input;
    const counts = countSeverities(report.rows);
    const title = `Token audit: ${diff.newRed.length} new RED, ${diff.crossed.length + diff.risen.length} regressed`;
    const summary = `${diff.reasons.slice(0, 4).join("; ")}${diff.reasons.length > 4 ? `; and ${diff.reasons.length - 4} more` : ""}. ${counts.RED} RED, ${counts.AMBER} AMBER in all. Report: ${markdownPath}`;
    if (!config.escalation.enabled) {
      await this.send(
        {
          title,
          body: summary,
          data: { serverId: this.options.serverId, reason: "token_audit_regressed" },
        },
        { level: "notice", dedupeKey: `token-audit:${report.generatedAt}` },
      );
      return false;
    }
    const observation: RemediationObservation = {
      key: episodeKey,
      kind: "token-audit",
      active: true,
      remedy: "none",
      title,
      summary,
      evidence: evidenceFor(report.rows, diff),
      level: "notice",
      escalation: {
        task: TOKEN_AUDIT_ADVICE_TASK,
        cwd: this.options.paseoHome,
        taskClass: "mechanical",
        budgetTokens: config.escalation.budgetTokens,
        timeoutMinutes: config.escalation.timeoutMinutes,
        advice: true,
      },
    };
    await this.options.sink.observe(observation);
    return true;
  }

  private async send(
    payload: Parameters<PushNotificationSender["send"]>[0],
    meta: Parameters<PushNotificationSender["send"]>[1],
  ): Promise<void> {
    try {
      await this.options.getPushNotificationSender().send(payload, meta);
    } catch (error) {
      this.options.logger.warn({ err: error }, "Token audit: push failed");
    }
  }
}

/** Why it escalated, then the rows that are not GREEN, worst first. */
export function evidenceFor(rows: readonly TokenAuditRow[], diff: ReportDiff): string {
  const notGreen = rows
    .filter((r) => r.severity !== "GREEN")
    .sort((a, b) => order(a) - order(b))
    .slice(0, EVIDENCE_ROWS);
  return [
    "Why this report escalated:",
    ...diff.reasons.map((reason) => `- ${reason}`),
    "",
    "Rows that are not GREEN, worst first:",
    renderTokenAuditTable(notGreen),
  ].join("\n");
}

function order(r: TokenAuditRow): number {
  return { RED: 0, AMBER: 1, UNKNOWN: 2, GREEN: 3 }[r.severity];
}
