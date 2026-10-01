import type { RemediationTaskClass } from "./config.js";

/**
 * The contract between a monitor and the remediation ladder (docs/remediation.md).
 *
 * A monitor detects a condition and runs its deterministic remedy (rung 1). It then tells the
 * ladder, every sweep, whether the condition still holds and what the remedy can do about it.
 * The ladder owns everything after that: the grace window, the one bounded agent (rung 2), the
 * cooldown, and the one push to a person (rung 3). A monitor on the ladder never pushes about a
 * condition itself.
 */

/** Every condition on the ladder. A new one gets a row in docs/remediation.md. */
export type RemediationConditionKind =
  | "orphan-build-daemons"
  | "system-memory"
  | "cpu-saturation"
  | "disk-low"
  | "disk-critical"
  | "disk-falling"
  | "stalled-agent"
  | "work-at-risk"
  | "account-pool-exhausted"
  | "token-audit"
  /**
   * The stall judgment's loop watch (docs/jev.md, Feature 10), reported for a running agent that
   * is not a stall candidate: remedy `none`, no escalation, level `notice`, grace 0. A person gets
   * it in the digest; nothing interrupts the agent on the loop watch's say-so.
   */
  | "looping-agent";

/** What rung 1 can do about the condition right now. */
export type RemedyState =
  /** A deterministic remedy is on and acting. The ladder waits out the grace window first. */
  | "live"
  /** The remedy exists and is turned off. The operator opted out: rung 3, no agent. */
  | "disabled"
  /** The remedy exists and is in dry run, so it cannot act. Rung 3, no agent. */
  | "dry-run"
  /** No deterministic remedy exists. Rung 2 if the observation names a task, else rung 3. */
  | "none";

export interface RemedyAttempt {
  /** Short remedy name: `reaper`, `artifact-janitor`, `done-janitor`, `nudge`, `snapshot`. */
  remedy: string;
  outcome: "acted" | "nothing-to-do" | "failed" | "skipped";
  /** One line, shown to the agent and in the push verbatim: what it did, or why it did not. */
  detail: string;
  /** ISO time. */
  at: string;
}

export interface RemediationEscalationRequest {
  /**
   * What the agent should try, in the imperative. The ladder adds the evidence, the attempts, the
   * limits and the report format; this is only the job.
   */
  task: string;
  /** The agent's working directory. Absent: the user's home directory. */
  cwd?: string;
  /** Absent: the ladder config's. `hard` only when the condition needs it. */
  taskClass?: RemediationTaskClass;
  /**
   * The token ceiling for this agent, overriding the ladder config's; `conditions.<kind>` in
   * config still wins. A monitor whose task is small says so here so `paseo.budget` is small.
   */
  budgetTokens?: number;
  /** Minutes before the agent is cancelled, overriding the ladder config's. */
  timeoutMinutes?: number;
  /**
   * The agent's job is a recommendation, not a fix. It ends with `RECOMMENDATION: <one line>`,
   * and rung 3 pushes that line under the observation's own title. No FIXED outcome exists for
   * an advisory episode, so the ladder never archives the agent or waits for the condition to clear.
   */
  advice?: boolean;
  /**
   * Set by the stall judgment (docs/jev.md, Feature 10) when its answer was `blocked_missing_info`
   * or `waiting_on_human`. The ladder is the one place that decides: it skips the agent for this
   * observation only when the escalation will push (`condition.notify` true and the level `notice`
   * or higher), the same rule that governs a `needs_person` remediation triage (Feature 3a).
   */
  personFirst?: { reason: string; confidence: number };
}

export interface RemediationObservation {
  /**
   * One condition instance. The ladder keeps at most one open episode, one agent and one cooldown
   * per key: `orphan-build-daemons`, `stalled-agent:<agentId>`, `work-at-risk:<worktree path>`.
   */
  key: string;
  kind: RemediationConditionKind;
  /** Whether the condition holds now. `false` closes an open episode as resolved. */
  active: boolean;
  remedy: RemedyState;
  /** Short and plain; the push title and the agent's title. */
  title: string;
  /** One or two sentences: what is wrong now. */
  summary: string;
  /** What rung 1 already found, handed to the agent so it does not re-derive it. Plain text. */
  evidence?: string;
  /** What rung 1 did this episode, oldest first. The monitor accumulates the list. */
  attempts?: readonly RemedyAttempt[];
  /**
   * With a `live` remedy: how long the condition may stay active before rung 2. The config's
   * `conditions.<kind>.graceMinutes` overrides it. Default 0.
   */
  graceMs?: number;
  /**
   * How long the sender put off its own rung-1 action (a stall judgment's hold). Added to the
   * grace, whether it is `graceMs` or the config's override, so rung 2 never starts before it.
   */
  holdMs?: number;
  /** The rung 3 level. Default `alert`. */
  level?: "notice" | "alert" | "urgent";
  /** Absent: no agent can help, so rung 2 is skipped. */
  escalation?: RemediationEscalationRequest;
  /** Deep link for the push. */
  link?: { agentId?: string; workspaceId?: string };
}

export interface RemediationSink {
  /**
   * Report the condition's state. Call it every sweep while the condition is active and once
   * after it clears. Repeats are free: the ladder is idempotent per key. Never throws.
   */
  observe(observation: RemediationObservation): Promise<void>;
}

/** For tests and for a monitor constructed before the ladder exists. */
export const NULL_REMEDIATION_SINK: RemediationSink = {
  observe: async () => undefined,
};

export interface ForwardingRemediationSink extends RemediationSink {
  attach(target: RemediationSink): void;
}

/**
 * Bootstrap builds some monitors before the ladder can exist (the ladder needs the push sender
 * and the create path). They take this sink at construction, and bootstrap attaches the ladder
 * once it is built. An observation before then is dropped, which costs nothing: a monitor reports
 * again on its next sweep.
 */
export function createForwardingRemediationSink(): ForwardingRemediationSink {
  let target: RemediationSink = NULL_REMEDIATION_SINK;
  return {
    attach(next) {
      target = next;
    },
    async observe(observation) {
      await target.observe(observation);
    },
  };
}

export interface WorktreeSnapshotRequest {
  /** Any directory inside the worktree, usually the agent's cwd. */
  cwd: string;
  /** Names the ref `refs/backup/<date>/<slug>`. Absent: derived from the worktree path. */
  slug?: string;
  /** Why, for the commit message: `stalled agent 1a2b3c4d before a resume nudge`. */
  reason: string;
  /** Also push (personal GitHub) or bundle (anything else). Default true. */
  offsite?: boolean;
}

export type WorktreeSnapshotOffsite =
  | { kind: "pushed"; remote: string; branch: string }
  | { kind: "bundled"; path: string }
  | { kind: "none"; reason: string };

export type WorktreeSnapshotResult =
  | { kind: "nothing-at-risk"; worktreePath: string }
  | {
      kind: "snapshotted";
      worktreePath: string;
      ref: string;
      commit: string;
      dirtyFiles: number;
      unpushedCommits: number;
      /** Untracked files over the size cap, left out of the snapshot. */
      skippedFiles: readonly string[];
      /**
       * Untracked files left out because they look like secrets, for a snapshotter that filters
       * them. Absent reads as none. The done janitor keeps a worktree when this is non-empty, and
       * reads every worktree against the snapshot before deleting it whatever this says.
       */
      possibleSecrets?: readonly string[];
      offsite: WorktreeSnapshotOffsite;
    }
  | { kind: "failed"; worktreePath: string | null; error: string };

/**
 * Snapshots a worktree's uncommitted and unpushed work without touching it: a commit built
 * through a temporary `GIT_INDEX_FILE`, stored under `refs/backup/`. The agent's index, tree and
 * HEAD are never written. See docs/work-snapshots.md.
 */
export interface WorktreeSnapshotter {
  snapshot(request: WorktreeSnapshotRequest): Promise<WorktreeSnapshotResult>;
}

/** Stands in until the real snapshotter is wired; every snapshot reports as failed. */
export const UNAVAILABLE_WORKTREE_SNAPSHOTTER: WorktreeSnapshotter = {
  snapshot: async () => ({
    kind: "failed",
    worktreePath: null,
    error: "no worktree snapshotter is wired in this daemon",
  }),
};
