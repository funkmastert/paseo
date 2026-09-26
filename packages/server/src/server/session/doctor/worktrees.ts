import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";
import { checkWorktreeDeletionSafety } from "../../done-janitor-worktree.js";
import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import { formatBytes, isInside, realpathOrNull } from "./helpers.js";

const QUICK_BUDGET_MS = 25_000;
const DEEP_BUDGET_MS = 5 * 60_000;
/** Git runs through the daemon's shared process scheduler; a sweep must not crowd out real work. */
const CONCURRENCY = 3;
const LISTED_RECLAIMABLE = 12;

interface WorktreeEntry {
  name: string;
  dir: string;
  /** Null until measured. */
  bytes: number | null;
  live: boolean;
  pinned: boolean;
  reclaimable: boolean;
  /** Why the git gate refused, when it ran and refused. */
  keptBecause: string | null;
  checked: boolean;
}

/** `<paseoHome>/worktrees/<project>/<name>` — the layout Paseo creates worktrees in. */
function listWorktreeDirs(paseoHome: string): Array<{ name: string; dir: string }> {
  const root = path.join(paseoHome, "worktrees");
  const out: Array<{ name: string; dir: string }> = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(path.join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root, project, name);
      if (existsSync(path.join(dir, ".git"))) out.push({ name, dir });
    }
  }
  return out;
}

function baseBranchFor(ctx: DoctorContext, dir: string): string | null {
  const real = realpathOrNull(dir) ?? dir;
  const match = ctx.facts.workspaces?.find((workspace) => {
    const cwd = realpathOrNull(workspace.cwd) ?? workspace.cwd;
    return cwd === real;
  });
  return match?.baseBranch ?? null;
}

function isPinned(ctx: DoctorContext, dir: string): boolean {
  const real = realpathOrNull(dir) ?? dir;
  return (ctx.facts.workspaces ?? []).some(
    (workspace) => workspace.pinned && (realpathOrNull(workspace.cwd) ?? workspace.cwd) === real,
  );
}

function hasLiveAgent(ctx: DoctorContext, dir: string): boolean {
  const real = realpathOrNull(dir) ?? dir;
  return (ctx.facts.agents ?? []).some((agent) => {
    if (agent.archived || agent.status === "closed") return false;
    const cwd = realpathOrNull(agent.cwd) ?? agent.cwd;
    return isInside(real, cwd);
  });
}

async function runPool<T>(
  items: T[],
  deadline: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++]!;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * Worktrees are the biggest thing Paseo leaves on disk (~3 GB each with `node_modules`). Reports
 * how many there are, how big, and which are reclaimable: linked worktrees whose tree is clean,
 * whose commits exist on a remote or the base branch (the done janitor's git gate, read-only),
 * and that no live agent is working in.
 */
export const worktreeCheck: DoctorCheck = {
  id: "worktrees",
  category: "disk",
  timeoutMs: (ctx) => (ctx.deep ? DEEP_BUDGET_MS : QUICK_BUDGET_MS) + 10_000,
  async run(ctx, deadline) {
    const budgetEnd = Math.min(
      deadline - 5_000,
      ctx.now() + (ctx.deep ? DEEP_BUDGET_MS : QUICK_BUDGET_MS),
    );
    const entries: WorktreeEntry[] = listWorktreeDirs(ctx.paseoHome).map(({ name, dir }) => ({
      name,
      dir,
      bytes: null,
      live: hasLiveAgent(ctx, dir),
      pinned: isPinned(ctx, dir),
      reclaimable: false,
      keptBecause: null,
      checked: false,
    }));
    if (entries.length === 0) {
      return [finding("worktrees", "disk", "ok", "No Paseo worktrees on disk")];
    }
    // Idle ones first: they are the reclaim candidates, so a partial sweep still finds them.
    const order = [...entries].sort((a, b) => Number(a.live) - Number(b.live));
    await runPool(order, budgetEnd, async (entry) => {
      if (!entry.live) {
        const safety = await checkWorktreeDeletionSafety({
          worktreePath: entry.dir,
          baseBranch: baseBranchFor(ctx, entry.dir),
          runGit: ctx.probes.runGit,
        });
        entry.checked = true;
        // A pinned workspace is one a person chose to keep; the done janitor spares it too.
        entry.reclaimable = safety.safe && !entry.pinned;
        entry.keptBecause = safety.safe ? null : safety.reason;
      }
      entry.bytes = await ctx.probes.measureDirBytes(entry.dir, budgetEnd);
    });

    const measured = entries.filter((entry) => entry.bytes !== null);
    const totalBytes = measured.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    const complete =
      measured.length === entries.length && entries.every((e) => e.live || e.checked);
    const live = entries.filter((entry) => entry.live).length;
    const out: DoctorFinding[] = [
      finding(
        "worktrees.size",
        "disk",
        complete ? "ok" : "warn",
        `${entries.length} worktrees on disk, ${formatBytes(totalBytes)}${complete ? "" : ` (measured ${measured.length} of ${entries.length})`}; ${live} with a live agent`,
        complete
          ? undefined
          : {
              detail: `The ${ctx.deep ? "deep" : "quick"} sweep hit its ${Math.round((ctx.deep ? DEEP_BUDGET_MS : QUICK_BUDGET_MS) / 1000)}s budget, so these numbers are a floor.`,
              fix: ctx.deep ? undefined : "paseo doctor --deep",
            },
      ),
    ];

    const reclaimable = entries
      .filter((entry) => entry.reclaimable)
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    if (reclaimable.length > 0) {
      const bytes = reclaimable.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
      const shown = reclaimable.slice(0, LISTED_RECLAIMABLE);
      out.push(
        finding(
          "worktrees.reclaimable",
          "disk",
          "warn",
          `${reclaimable.length} worktree(s), ${formatBytes(bytes)}, are clean, merged or pushed, and have no live agent`,
          {
            detail: [
              ...shown.map(
                (entry) =>
                  `${entry.dir} (${entry.bytes === null ? "size unknown" : formatBytes(entry.bytes)})`,
              ),
              ...(reclaimable.length > shown.length
                ? [`…and ${reclaimable.length - shown.length} more`]
                : []),
            ].join("\n"),
            why: "Every commit in them is on a remote or the base branch, so nothing is lost, and each holds gigabytes of node_modules and build output.",
            fix: `${shown.map((entry) => `paseo worktree archive ${entry.name}`).join("\n")}\n# or let the done janitor do it: agents.doneJanitor.enabled`,
          },
        ),
      );
    }
    return out;
  },
};
