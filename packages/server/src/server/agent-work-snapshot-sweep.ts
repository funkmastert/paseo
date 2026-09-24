import { existsSync, readFileSync } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { UNRESPONSIVE_CANCEL_ERROR } from "./agent/turn-cancel.js";
import type { DetailedWorktreeSnapshot, WorktreeAssessment } from "./agent/worktree-snapshot.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import type {
  RemediationObservation,
  RemediationSink,
  RemedyAttempt,
  WorktreeSnapshotOffsite,
  WorktreeSnapshotRequest,
} from "./remediation/contract.js";
import { resolveWorkSnapshotsConfig, type RemediationConfig } from "./remediation/config.js";
import { isRealpathInsideRoot } from "../utils/path.js";

/** How often the sweep checks whether `sweepMinutes` has passed; the config is re-read each time. */
const CHECK_INTERVAL_MS = 60_000;
/** The first sweep waits this long after start, so a restart's burst of closed agents settles. */
const FIRST_SWEEP_DELAY_MS = 5 * 60_000;
/**
 * A closed or wedged agent must be this quiet before its worktree counts as at risk. A restart
 * closes every agent at once; most are resumed within minutes. Snapshots are cheap and this is
 * well inside the three days before macOS purges `/tmp`.
 */
const DEAD_QUIET_MS = 60 * 60_000;
const KEY = "work-at-risk";

export const WORK_AT_RISK_JUDGE_TASK =
  "Judge each snapshot: is it real unintegrated work that needs follow-up, or scratch, duplicate or already integrated elsewhere? Do not modify any worktree. Report FIXED if none need follow-up; NOT_FIXED naming the ones that do.";

/** One agent the daemon knows, live or stored. */
export interface WorkSnapshotAgentView {
  id: string;
  title: string | null;
  cwd: string;
  workspaceId: string | undefined;
  archived: boolean;
  /** Whether the daemon holds a runtime for it. False is `closed`. */
  live: boolean;
  lifecycle: AgentLifecycleStatus;
  busy: boolean;
  lastError: string | null;
  lastActivityAtMs: number | null;
}

export type WorkAtRiskReason = "dead" | "wedged" | "archived" | "orphaned";

export interface WorkSnapshotSweepSnapshotter {
  assess(cwd: string): Promise<WorktreeAssessment>;
  snapshotWithDetail(request: WorktreeSnapshotRequest): Promise<DetailedWorktreeSnapshot>;
}

export interface WorkSnapshotSweepDependencies {
  listAgents(): Promise<WorkSnapshotAgentView[]>;
  /** The directory of every workspace that is not archived. */
  listActiveWorkspaceDirectories(): Promise<string[]>;
  /** Every `<worktrees root>/<hash>/<slug>` directory. */
  listOrphanCandidates(): Promise<string[]>;
  snapshotter: WorkSnapshotSweepSnapshotter;
}

export interface AgentWorkSnapshotSweepOptions {
  dependencies: WorkSnapshotSweepDependencies;
  sink: RemediationSink;
  readConfig: () => RemediationConfig | undefined;
  /** Where what was handed over is kept: `$PASEO_HOME/work-snapshots.json`. */
  statePath: string;
  logger: Logger;
  now?: () => number;
}

/** One worktree the sweep snapshotted, or in a dry run would have. */
export interface WorkSnapshotSweepEntry {
  worktreePath: string;
  reason: WorkAtRiskReason;
  branch: string | null;
  owner: { id: string; title: string | null } | null;
  dirtyFiles: number;
  unpushedCommits: number;
  outcome:
    | { kind: "snapshotted"; ref: string; offsite: WorktreeSnapshotOffsite; skippedFiles: number }
    | { kind: "failed"; error: string }
    | { kind: "would-snapshot" };
  /** Not handed over before in this state. */
  isNew: boolean;
}

export interface WorkSnapshotSweepReport {
  dryRun: boolean;
  snapshots: WorkSnapshotSweepEntry[];
  /** Whether this sweep handed a batch to the ladder. */
  handedOver: boolean;
}

const HandedOverSchema = z.object({
  head: z.string().nullable(),
  tree: z.string().nullable(),
  ref: z.string().nullable(),
  at: z.string(),
});

const StateSchema = z.object({
  version: z.literal(1),
  /** A batch was observed active and not yet reported inactive. */
  episodeOpen: z.boolean(),
  handedOver: z.record(z.string(), HandedOverSchema),
});

type SweepState = z.infer<typeof StateSchema>;

interface Candidate {
  worktreePath: string;
  reason: WorkAtRiskReason;
  agents: WorkSnapshotAgentView[];
  assessment: Extract<WorktreeAssessment, { kind: "assessed" }>;
}

/**
 * Why an agent's worktree may hold work nobody is going to save, or null for an agent that is
 * working or may be picked up again any minute.
 */
export function classifyAgent(view: WorkSnapshotAgentView, nowMs: number): WorkAtRiskReason | null {
  if (view.archived) return "archived";
  if (view.busy || view.lifecycle === "running" || view.lifecycle === "initializing") return null;
  const quiet = view.lastActivityAtMs !== null && nowMs - view.lastActivityAtMs >= DEAD_QUIET_MS;
  if (!quiet) return null;
  if (!view.live) return "dead";
  if (view.lifecycle === "error" || view.lastError === UNRESPONSIVE_CANCEL_ERROR) return "wedged";
  return null;
}

function isUnderTmp(path: string): boolean {
  return /^\/(?:private\/)?tmp\//.test(path);
}

/**
 * Snapshots the worktrees of dead, wedged and archived agents, and orphaned Paseo worktrees, then
 * hands each new batch to one judge agent through the remediation ladder. See
 * docs/work-snapshots.md.
 *
 * Same shape as its sibling monitors: an unref'd timer, the config re-read every sweep, a sweep
 * never overlapping the last.
 */
export class AgentWorkSnapshotSweep {
  private readonly options: AgentWorkSnapshotSweepOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private nextSweepAtMs: number | null = null;
  /** The snapshot details of this sweep, by worktree, for the state written at its end. */
  private readonly lastDetail = new Map<string, { head: string | null; tree: string | null }>();

  constructor(options: AgentWorkSnapshotSweepOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.nextSweepAtMs = this.now() + FIRST_SWEEP_DELAY_MS;
    const timer = setInterval(() => {
      if (this.nextSweepAtMs === null || this.now() < this.nextSweepAtMs) return;
      const { sweepMinutes } = resolveWorkSnapshotsConfig(this.options.readConfig());
      this.nextSweepAtMs = this.now() + sweepMinutes * 60_000;
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Work-at-risk sweep failed");
      });
    }, CHECK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one sweep; null when disabled or when another sweep is in flight. */
  async tick(): Promise<WorkSnapshotSweepReport | null> {
    if (this.sweepInFlight) return null;
    this.sweepInFlight = true;
    try {
      return await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<WorkSnapshotSweepReport | null> {
    const config = resolveWorkSnapshotsConfig(this.options.readConfig());
    if (!config.enabled) return null;
    const { logger, sink } = this.options;
    const nowMs = this.now();
    const state = this.loadState();
    const report: WorkSnapshotSweepReport = {
      dryRun: config.dryRun,
      snapshots: [],
      handedOver: false,
    };

    // The ladder still reads the judge's report after the episode closes. Closing it first keeps
    // one batch per episode; anything new this sweep is handed over on the next.
    const closing = state.episodeOpen && !config.dryRun;
    if (closing) {
      await sink.observe({
        key: KEY,
        kind: "work-at-risk",
        active: false,
        remedy: "none",
        title: "Work at risk handed over",
        summary: "The last batch of snapshots was handed to a judge agent.",
      });
      state.episodeOpen = false;
    }

    const candidates = await this.listCandidates(nowMs);
    let budget = config.maxPerSweep;
    for (const candidate of candidates) {
      if (budget <= 0) break;
      budget -= 1;
      const entry = config.dryRun
        ? describeDryRun(candidate, state)
        : await this.snapshotCandidate(candidate, state);
      report.snapshots.push(entry);
      if (config.dryRun) {
        logger.info({ ...entry, dryRun: true }, "Work-at-risk sweep (dry run): would snapshot");
      }
    }

    if (config.dryRun) return report;

    const fresh = report.snapshots.filter((entry) => entry.isNew);
    if (fresh.length > 0 && !closing) {
      await this.handOver(fresh, state, nowMs);
      report.handedOver = true;
    }
    this.lastDetail.clear();
    for (const path of Object.keys(state.handedOver)) {
      if (!existsSync(path)) delete state.handedOver[path];
    }
    await this.saveState(state);
    return report;
  }

  /** One observation for the whole batch, and a record of each worktree so it is handed over once. */
  private async handOver(
    fresh: readonly WorkSnapshotSweepEntry[],
    state: SweepState,
    nowMs: number,
  ): Promise<void> {
    await this.options.sink.observe(buildObservation(fresh, nowMs));
    state.episodeOpen = true;
    for (const entry of fresh) {
      const detail = this.lastDetail.get(entry.worktreePath);
      state.handedOver[entry.worktreePath] = {
        head: detail?.head ?? null,
        tree: detail?.tree ?? null,
        ref: entry.outcome.kind === "snapshotted" ? entry.outcome.ref : null,
        at: new Date(nowMs).toISOString(),
      };
    }
    this.options.logger.info(
      { worktrees: fresh.map((entry) => entry.worktreePath) },
      "Work-at-risk sweep: handed a batch of snapshots to the ladder",
    );
  }

  private async snapshotCandidate(
    candidate: Candidate,
    state: SweepState,
  ): Promise<WorkSnapshotSweepEntry> {
    const owner = pickOwner(candidate.agents);
    const detail = await this.options.dependencies.snapshotter.snapshotWithDetail({
      cwd: candidate.worktreePath,
      reason: `Work-at-risk sweep: ${describeCandidate(candidate.reason, owner)}.`,
    });
    const { result } = detail;
    const previous = state.handedOver[candidate.worktreePath];
    this.lastDetail.set(candidate.worktreePath, { head: detail.head, tree: detail.tree });
    const base = {
      worktreePath: candidate.worktreePath,
      reason: candidate.reason,
      branch: detail.branch,
      owner: owner ? { id: owner.id, title: owner.title } : null,
      dirtyFiles: candidate.assessment.dirtyFiles,
      unpushedCommits: candidate.assessment.unpushedCommits,
    };
    if (result.kind === "snapshotted") {
      return {
        ...base,
        dirtyFiles: result.dirtyFiles,
        unpushedCommits: result.unpushedCommits,
        outcome: {
          kind: "snapshotted",
          ref: result.ref,
          offsite: result.offsite,
          skippedFiles: result.skippedFiles.length,
        },
        isNew: !previous || previous.tree !== detail.tree || previous.head !== detail.head,
      };
    }
    // Clean since it was assessed: nothing to hand over.
    if (result.kind === "nothing-at-risk") {
      return { ...base, outcome: { kind: "failed", error: "clean since assessed" }, isNew: false };
    }
    // A failed snapshot of work at risk is exactly what the judge should hear about, once per HEAD.
    return {
      ...base,
      outcome: { kind: "failed", error: result.error },
      isNew: !previous || previous.ref !== null || previous.head !== detail.head,
    };
  }

  /** Worktrees at risk, `/tmp` first, then those never handed over, then the rest. */
  private async listCandidates(nowMs: number): Promise<Candidate[]> {
    const deps = this.options.dependencies;
    const agents = (await deps.listAgents()).filter((view) => existsSync(view.cwd));
    const healthyCwds = agents
      .filter((view) => !view.archived && classifyAgent(view, nowMs) === null)
      .map((view) => view.cwd);
    const byPath = new Map<string, Candidate>();
    const assessments = new Map<string, WorktreeAssessment>();
    const assess = async (cwd: string) => {
      const cached = assessments.get(cwd);
      if (cached) return cached;
      const assessment = await deps.snapshotter.assess(cwd);
      assessments.set(cwd, assessment);
      return assessment;
    };
    const add = async (
      cwd: string,
      reason: WorkAtRiskReason,
      view: WorkSnapshotAgentView | null,
    ) => {
      const assessment = await assess(cwd);
      if (assessment.kind !== "assessed" || !assessment.atRisk) return;
      const path = assessment.worktreePath;
      // Someone is still working there; its work is theirs to save.
      if (healthyCwds.some((healthy) => isRealpathInsideRoot(path, healthy))) return;
      const existing = byPath.get(path);
      if (existing) {
        if (view) existing.agents.push(view);
        existing.reason = strongerReason(existing.reason, reason);
        return;
      }
      byPath.set(path, { worktreePath: path, reason, agents: view ? [view] : [], assessment });
    };

    for (const view of agents) {
      const reason = classifyAgent(view, nowMs);
      if (reason) await add(view.cwd, reason, view);
    }
    const active = await deps.listActiveWorkspaceDirectories();
    for (const dir of await deps.listOrphanCandidates()) {
      if (!existsSync(dir)) continue;
      if (
        active.some((other) => isRealpathInsideRoot(dir, other) || isRealpathInsideRoot(other, dir))
      ) {
        continue;
      }
      await add(dir, "orphaned", null);
    }

    const state = this.loadState();
    const rank = (candidate: Candidate) =>
      (isUnderTmp(candidate.worktreePath) ? 0 : 2) +
      (state.handedOver[candidate.worktreePath] ? 1 : 0);
    return [...byPath.values()].sort((a, b) => rank(a) - rank(b));
  }

  private loadState(): SweepState {
    const empty: SweepState = { version: 1, episodeOpen: false, handedOver: {} };
    if (!existsSync(this.options.statePath)) return empty;
    try {
      const parsed = StateSchema.safeParse(
        JSON.parse(readFileSync(this.options.statePath, "utf8")),
      );
      if (parsed.success) return parsed.data;
      this.options.logger.warn("Work-at-risk sweep: unreadable state file; starting fresh");
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Work-at-risk sweep: unreadable state file; starting fresh",
      );
    }
    return empty;
  }

  private async saveState(state: SweepState): Promise<void> {
    try {
      await writeJsonFileAtomic(this.options.statePath, state);
    } catch (error) {
      this.options.logger.warn({ err: error }, "Work-at-risk sweep: could not write its state");
    }
  }
}

const REASON_ORDER: readonly WorkAtRiskReason[] = ["orphaned", "archived", "dead", "wedged"];

/** A worktree several agents share is described by the most urgent reason among them. */
function strongerReason(a: WorkAtRiskReason, b: WorkAtRiskReason): WorkAtRiskReason {
  return REASON_ORDER.indexOf(a) >= REASON_ORDER.indexOf(b) ? a : b;
}

function pickOwner(agents: readonly WorkSnapshotAgentView[]): WorkSnapshotAgentView | null {
  return (
    [...agents].sort((a, b) => (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0))[0] ?? null
  );
}

function describeCandidate(
  reason: WorkAtRiskReason,
  owner: Pick<WorkSnapshotAgentView, "id"> | null,
): string {
  if (!owner) return "orphaned worktree with no active workspace";
  return `${reason} agent ${owner.id.slice(0, 8)}`;
}

function describeDryRun(candidate: Candidate, state: SweepState): WorkSnapshotSweepEntry {
  const owner = pickOwner(candidate.agents);
  return {
    worktreePath: candidate.worktreePath,
    reason: candidate.reason,
    branch: candidate.assessment.branch,
    owner: owner ? { id: owner.id, title: owner.title } : null,
    dirtyFiles: candidate.assessment.dirtyFiles,
    unpushedCommits: candidate.assessment.unpushedCommits,
    outcome: { kind: "would-snapshot" },
    isNew: !state.handedOver[candidate.worktreePath],
  };
}

function describeOffsite(offsite: WorktreeSnapshotOffsite): string {
  switch (offsite.kind) {
    case "pushed":
      return `pushed to ${offsite.remote} as ${offsite.branch}`;
    case "bundled":
      return `bundled at ${offsite.path}`;
    case "none":
      return `local only (${offsite.reason})`;
  }
}

function describeOutcome(outcome: WorkSnapshotSweepEntry["outcome"]): string {
  switch (outcome.kind) {
    case "snapshotted": {
      const skipped =
        outcome.skippedFiles > 0
          ? `; ${outcome.skippedFiles} large untracked file(s) left out`
          : "";
      return `ref ${outcome.ref}; offsite: ${describeOffsite(outcome.offsite)}${skipped}`;
    }
    case "failed":
      return `SNAPSHOT FAILED: ${outcome.error}`;
    case "would-snapshot":
      return "not snapshotted (dry run)";
  }
}

function describeEntry(entry: WorkSnapshotSweepEntry): string {
  const owner = entry.owner
    ? `agent ${entry.owner.id} "${entry.owner.title ?? "untitled"}" (${entry.reason})`
    : "no agent (orphaned worktree)";
  const counts = `${entry.dirtyFiles} dirty file(s), ${entry.unpushedCommits} unpushed commit(s)`;
  const outcome = describeOutcome(entry.outcome);
  return `- ${entry.worktreePath} (branch ${entry.branch ?? "detached or unborn"}) — ${owner}; ${counts}; ${outcome}`;
}

function buildObservation(
  entries: readonly WorkSnapshotSweepEntry[],
  nowMs: number,
): RemediationObservation {
  const at = new Date(nowMs).toISOString();
  const snapshotted = entries.filter((entry) => entry.outcome.kind === "snapshotted").length;
  const failed = entries.length - snapshotted;
  const attempts: RemedyAttempt[] = [];
  if (snapshotted > 0) {
    attempts.push({
      remedy: "snapshot",
      outcome: "acted",
      detail: `snapshotted ${snapshotted} worktree(s) under refs/backup/`,
      at,
    });
  }
  if (failed > 0) {
    attempts.push({
      remedy: "snapshot",
      outcome: "failed",
      detail: `could not snapshot ${failed} worktree(s); their work is unprotected`,
      at,
    });
  }
  const singleOwner = entries.length === 1 ? entries[0]?.owner : null;
  return {
    key: KEY,
    kind: "work-at-risk",
    active: true,
    remedy: "none",
    title: `Work at risk in ${entries.length} worktree(s)`,
    summary: `${entries.length} worktree(s) of dead, wedged or archived agents, or orphaned, hold uncommitted or unpushed work. Each is snapshotted; a judge decides which need follow-up.`,
    evidence: [
      "Snapshots (restore one with `git checkout -b restore <ref>` in that repository, or `git bundle unbundle`):",
      ...entries.map(describeEntry),
    ].join("\n"),
    attempts,
    graceMs: 0,
    level: "alert",
    escalation: { task: WORK_AT_RISK_JUDGE_TASK, taskClass: "mechanical" },
    ...(singleOwner ? { link: { agentId: singleOwner.id } } : {}),
  };
}
