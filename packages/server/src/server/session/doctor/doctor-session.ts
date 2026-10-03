import type pino from "pino";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { DoctorAgentFact, DoctorPluginFact, DoctorWorkspaceFact } from "./context.js";
import { buildDoctorContext } from "./facts.js";
import { runDoctorChecks } from "./runner.js";

export interface DoctorSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface DoctorSessionOptions {
  host: DoctorSessionHost;
  paseoHome: string;
  /** The user home the account dirs live under. Defaults to the process user's. */
  home?: string;
  daemonVersion: string | undefined;
  getDaemonStartedAt: () => Promise<string | null>;
  listAgents: () => DoctorAgentFact[];
  listWorkspaces: () => Promise<DoctorWorkspaceFact[]>;
  listPlugins: () => DoctorPluginFact[];
  getPluginLogs: (id: string) => string[];
  listProviderUsage: () => Promise<ProviderUsage[]>;
  logger: pino.Logger;
}

/** Daemon-side inputs are gathered before any check runs, so each gets its own short deadline. */
const FACT_TIMEOUT_MS = 10_000;

function orNullAfter<T>(work: Promise<T>, ms = FACT_TIMEOUT_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), deadline]).finally(() => clearTimeout(timer));
}

/**
 * `daemon.doctor.request`: runs the doctor checks inside the daemon, where the running build,
 * the plugin runtime, the agent list and the config schema are the real ones. Read-only end to
 * end: it reads files and process state and answers, and changes nothing.
 */
export class DoctorSession {
  constructor(private readonly options: DoctorSessionOptions) {}

  async handleDoctorRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.doctor.request" }>,
  ): Promise<void> {
    const { options } = this;
    try {
      const [startedAt, workspaces, usage] = await Promise.all([
        orNullAfter(options.getDaemonStartedAt()),
        orNullAfter(options.listWorkspaces()),
        orNullAfter(options.listProviderUsage()),
      ]);
      const ctx = buildDoctorContext({
        paseoHome: options.paseoHome,
        home: options.home,
        deep: msg.deep === true,
        facts: {
          source: "daemon",
          daemon: {
            version: options.daemonVersion ?? null,
            startedAt,
            pid: process.pid,
            execPath: process.execPath,
          },
          plugins: options.listPlugins(),
          pluginLogs: options.getPluginLogs,
          agents: options.listAgents(),
          workspaces,
          usage,
        },
      });
      const findings = await runDoctorChecks(ctx);
      options.host.emit({
        type: "daemon.doctor.response",
        payload: {
          requestId: msg.requestId,
          generatedAt: new Date().toISOString(),
          daemonVersion: options.daemonVersion ?? null,
          findings,
        },
      });
    } catch (error) {
      options.logger.error({ err: error }, "Failed to run doctor");
      options.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }
}
