import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";

import type { AgentOperatorSignal, IdleTurnOutcome } from "../../agent/agent-manager.js";
import type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../../agent/agent-timeline-store-types.js";
import type { JevService } from "../../jev/contract.js";
import {
  createTestJevService,
  type JevFakeBehavior,
  type JevScriptedAnswer,
} from "../../jev/fake.js";
import { resolveAwayReplyConfig } from "../config.js";
import { AwayReplyDecisionFile } from "../decision-file.js";
import type { AwayReplyAgentView } from "../detect.js";
import { AWAY_REPLY_STATE_FILE, AwayReplyJob, type AwayReplyDependencies } from "../job.js";
import type { AwayReplyPresence } from "../presence.js";
import { AwayReplyState } from "../state.js";
import { MINUTE, T0, assistant, leaderView, rowsOf } from "./fixtures.js";

/** The job's harness: a fake fleet, the JEV fake, and real state and decision files on disk. */

export const MARKER = "[Auto-reply on Tyler's behalf — away >1h, JEV]";

/** The agent manager, as far as the job can see it. */
export class FakeFleet {
  agents: AwayReplyAgentView[] = [];
  timelines = new Map<string, AgentTimelineRow[]>();
  turns: Array<{ agentId: string; text: string }> = [];
  responses: Array<{ agentId: string; requestId: string; response: AgentPermissionResponse }> = [];
  attention: string[] = [];
  refuseTurns = false;
  presence: AwayReplyPresence | null = { clients: [], availability: "available" };
  clock: () => number = () => T0;

  add(agent: AwayReplyAgentView, rows: AgentTimelineRow[]): void {
    this.agents.push(agent);
    this.timelines.set(agent.id, rows);
  }

  agent(id: string): AwayReplyAgentView {
    const found = this.agents.find((entry) => entry.id === id);
    if (!found) throw new Error(`no agent ${id}`);
    return found;
  }

  append(agentId: string, entries: Parameters<typeof rowsOf>[0]): void {
    const rows = this.timelines.get(agentId) ?? [];
    const nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    this.timelines.set(agentId, [...rows, ...rowsOf(entries, nextSeq)]);
  }

  deps(): AwayReplyDependencies {
    return {
      listAgents: async () =>
        this.agents.map((agent) => ({ ...agent, labels: { ...agent.labels } })),
      readTimelineTail: (agentId, limit) => (this.timelines.get(agentId) ?? []).slice(-limit),
      listPinnedWorkspaceIds: async () => new Set(["ws-pinned"]),
      startTurnIfIdle: (agentId, text): Promise<IdleTurnOutcome> | null => {
        const agent = this.agent(agentId);
        if (
          this.refuseTurns ||
          agent.lifecycle !== "idle" ||
          agent.busy ||
          agent.pendingPermissions.length > 0
        ) {
          return null;
        }
        this.turns.push({ agentId, text });
        this.append(agentId, [{ at: this.clock(), item: { type: "user_message", text } }]);
        return Promise.resolve({ status: "completed", finalText: "" });
      },
      respondToPermission: async (agentId, requestId, response) => {
        const agent = this.agent(agentId);
        if (!agent.pendingPermissions.some((request) => request.id === requestId)) {
          throw new Error(`No pending permission request with id '${requestId}'`);
        }
        agent.pendingPermissions = agent.pendingPermissions.filter(
          (request) => request.id !== requestId,
        );
        this.responses.push({ agentId, requestId, response });
      },
      raiseAttention: async (agentId) => {
        this.attention.push(agentId);
      },
      readPresence: () => this.presence,
    };
  }
}

export interface HarnessOptions {
  answers?: Record<string, JevScriptedAnswer>;
  behavior?: JevFakeBehavior | JevFakeBehavior[];
  /** `agents.jev.awayReply`. Defaults to `{ dryRun: false }`, the live path. */
  awayReply?: Record<string, unknown>;
  jev?: JevService;
  wrapJev?: (jev: JevService) => JevService;
}

export const GO_WITH_B: Record<string, JevScriptedAnswer> = {
  needs_reply: { type: "noul", noul: 0.94 },
  wait_kind: { type: "choice", choice: "choose_option", confidence: 0.85 },
  option: { type: "choice", choice: "B", confidence: 0.9 },
  destructive: { type: "noul", noul: 0.01 },
  tyler_hold: { type: "noul", noul: 0.02 },
};

export const KEEP_GOING: Record<string, JevScriptedAnswer> = {
  needs_reply: { type: "noul", noul: 0.9 },
  wait_kind: { type: "choice", choice: "approve_plan", confidence: 0.85 },
  destructive: { type: "noul", noul: 0.01 },
  tyler_hold: { type: "noul", noul: 0.02 },
};

export const OPTIONS_MESSAGE = [
  "Two ways to fix the flaky socket test. SENTINEL-LAST-MESSAGE-4d2a",
  "Option A: add a retry around connect.",
  "Option B: wait for the ready event first.",
  "Which do you want?",
].join("\n");

export function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-"));
  const safeCwd = path.join(root, "work", "bozeo");
  const companyCwd = path.join(root, "mobile-worktrees", "app");
  const paseoHome = path.join(root, "paseo-home");
  mkdirSync(safeCwd, { recursive: true });
  mkdirSync(companyCwd, { recursive: true });
  const fleet = new FakeFleet();
  let nowMs = T0;
  fleet.clock = () => nowMs;
  let logText = "";
  const logger = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, callback) {
        logText += chunk.toString();
        callback();
      },
    }),
  );
  const awayReply = options.awayReply ?? { dryRun: false };
  const service =
    options.jev ??
    createTestJevService({
      answers: options.answers ?? GO_WITH_B,
      behavior: options.behavior,
      paseoHome,
      homeDir: root,
      config: { awayReply },
      service: {
        now: () => nowMs,
        resolveAgentCwds: async (ids) =>
          ids.map((id) => fleet.agents.find((agent) => agent.id === id)?.cwd ?? "/nonexistent"),
      },
    });
  const jev = options.wrapJev ? options.wrapJev(service) : service;
  const jevDir = path.join(paseoHome, "jev");
  const statePath = path.join(jevDir, AWAY_REPLY_STATE_FILE);
  const listeners = new Set<(signal: AgentOperatorSignal) => void>();

  function makeJob(jobNow: () => number = () => nowMs): AwayReplyJob {
    return new AwayReplyJob({
      dependencies: fleet.deps(),
      jev,
      readConfig: () => resolveAwayReplyConfig(awayReply),
      state: new AwayReplyState({ filePath: statePath, logger, now: jobNow }),
      decisionFile: new AwayReplyDecisionFile({ dir: jevDir, logger, now: jobNow }),
      homeDir: root,
      subscribeOperatorSignals: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      logger,
      now: jobNow,
    });
  }

  const decisionPath = path.join(jevDir, "away-reply-decisions.jsonl");
  const job = makeJob();
  let messageSeq = 0;

  /** What the agent manager tells the job. */
  function signal(entry: AgentOperatorSignal): void {
    for (const listener of listeners) listener(entry);
  }

  /** A message Tyler sends from the app: a timeline row, and the daemon's record of it. */
  function tyler(agentId: string, text: string, at: number): void {
    messageSeq += 1;
    const clientMessageId = `tyler-${messageSeq}`;
    fleet.append(agentId, [{ at, item: { type: "user_message", text, clientMessageId } }]);
    signal({ kind: "human-prompt", agentId, at: new Date(at), clientMessageId });
  }

  /** A leader Tyler asked something of, now waiting on him with `message`. */
  function waitingLeader(message = OPTIONS_MESSAGE, id = "leader-1"): void {
    fleet.add(leaderView({ id, cwd: safeCwd, requiresAttention: true }), []);
    tyler(id, "Fix the flaky test", T0);
    fleet.append(id, [assistant(message, T0 + MINUTE)]);
  }

  /** Every line of the decision file, once queued writes have landed. */
  async function decisionLines(from: AwayReplyJob = job): Promise<Array<Record<string, unknown>>> {
    await from.flush();
    if (!existsSync(decisionPath)) return [];
    return readFileSync(decisionPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  return {
    root,
    fleet,
    job,
    service,
    safeCwd,
    companyCwd,
    paseoHome,
    jevDir,
    statePath,
    decisionPath,
    makeJob,
    signal,
    tyler,
    waitingLeader,
    decisionLines,
    logs: () => logText,
    now: () => nowMs,
    at: (ms: number) => {
      nowMs = ms;
    },
    calls: () =>
      "transport" in service
        ? (service as { transport: { calls: unknown[] } }).transport.calls.length
        : 0,
    cleanup() {
      job.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type Harness = ReturnType<typeof harness>;
