/**
 * Pure, paranoid deletion gate for WorktreeDiskMonitor. No I/O, no clock reads — the monitor
 * enumerates on-disk worktree directories, resolves each one's registry state and git checkout
 * status itself, and calls this once per candidate. Every ambiguous input keeps the directory:
 * a bad timestamp, a checkout status the monitor couldn't resolve, an unknown ahead-of-origin
 * count, or a still-dirty tree are all "don't know" rather than "safe", and "don't know" never
 * deletes. See docs/plans/2026-09-12-007-feat-disk-sweeper-indicator-plan.md.
 *
 * `deletePaseoWorktree` (utils/worktree.ts) has no git-safety gate of its own — it trusts its
 * caller. For an explicit user-initiated archive that's fine; for an unattended sweeper it is
 * not, so this module is that gate, owned entirely by the sweeper.
 */

/**
 * How the monitor classifies an on-disk worktree directory against the workspace registry,
 * before retention or git status enters into it. `referenceAt` is the instant retention counts
 * from: the workspace's real `archivedAt` for a registered-archived directory, or the monitor's
 * own first-observed-unreferenced timestamp (tracked in memory, never persisted) for a directory
 * with no registry record at all. Untracked directories get the same retention treatment as
 * archived ones deliberately — see the plan's "untracked=archived semantics" — a dir the
 * registry has simply forgotten about (stale sibling records, legacy placement drift) is not
 * evidence it's safe to delete sooner than a normally-archived one.
 */
export type WorktreeRegistryState =
  | { kind: "archived"; referenceAt: string }
  | { kind: "unknown"; referenceAt: string };

/**
 * The minimal shape of `getCheckoutStatus`'s result this module needs. Deliberately not the full
 * `CheckoutStatusResult` from utils/checkout-git.ts — this module has no I/O and no reason to
 * import a git-facts type just to destructure three fields out of it.
 */
export type WorktreeCheckoutStatusForSweep =
  | { isGit: false }
  | {
      isGit: true;
      isDirty: boolean;
      /** null/undefined: no upstream, or git couldn't resolve one. Ambiguous — never "safe". */
      aheadOfOrigin: number | null | undefined;
    };

export interface EvaluateDeletionCandidateInput {
  onDiskPath: string;
  registryState: WorktreeRegistryState;
  retentionDays: number;
  checkoutStatus: WorktreeCheckoutStatusForSweep;
  nowMs: number;
}

export type DeletionDecision = "delete" | "keep-unsafe" | "keep-in-grace";

export function evaluateDeletionCandidate(input: EvaluateDeletionCandidateInput): DeletionDecision {
  const referenceMs = Date.parse(input.registryState.referenceAt);
  if (!Number.isFinite(referenceMs)) {
    // Unparseable reference timestamp. Can't know whether retention has elapsed, so it hasn't.
    return "keep-unsafe";
  }

  const retentionMs = input.retentionDays * 24 * 60 * 60 * 1000;
  if (input.nowMs - referenceMs < retentionMs) {
    return "keep-in-grace";
  }

  const status = input.checkoutStatus;
  if (!status.isGit) {
    // Can't positively confirm clean+not-ahead when git can't even read the checkout.
    return "keep-unsafe";
  }
  if (status.isDirty) {
    return "keep-unsafe";
  }
  if (status.aheadOfOrigin === null || status.aheadOfOrigin === undefined) {
    // No resolvable upstream comparison. Ambiguous, not safe.
    return "keep-unsafe";
  }
  if (status.aheadOfOrigin > 0) {
    return "keep-unsafe";
  }

  return "delete";
}
