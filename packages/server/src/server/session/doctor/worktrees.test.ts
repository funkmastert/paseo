import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeProbes, makeContext, makeFixture, snapshotTree } from "./test-support.js";
import { worktreeCheck } from "./worktrees.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A repo with worktrees under `<paseoHome>/worktrees/proj/`, in the layout Paseo creates. */
function makeRepoWithWorktrees() {
  const fx = makeFixture();
  const repo = path.join(fx.home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const root = path.join(fx.paseoHome, "worktrees", "proj");
  mkdirSync(root, { recursive: true });
  const add = (name: string) => {
    git(repo, "worktree", "add", "-q", "-b", name, path.join(root, name), "main");
    return realpathSync(path.join(root, name));
  };
  return { fx, repo, add };
}

describe("worktree check", () => {
  it("finds merged, clean worktrees with no live agent, and spares the rest", async () => {
    const { fx, add } = makeRepoWithWorktrees();
    const merged = add("merged");
    const unmerged = add("unmerged");
    writeFileSync(path.join(unmerged, "b.txt"), "b");
    git(unmerged, "add", ".");
    git(unmerged, "commit", "-q", "-m", "work");
    const dirty = add("dirty");
    writeFileSync(path.join(dirty, "scratch.txt"), "uncommitted");
    const live = add("live");
    const pinned = add("pinned");

    const workspaces = [merged, unmerged, dirty, live, pinned].map((cwd) => ({
      cwd,
      baseBranch: "main",
      archivedAt: null,
      pinned: cwd === pinned,
    }));
    const ctx = makeContext(
      fx,
      { workspaces, agents: [{ cwd: path.join(live, "src"), status: "running", archived: false }] },
      { probes: fakeProbes({ measureDirBytes: async () => 2 * 1024 ** 3 }) },
    );
    const before = snapshotTree(path.join(fx.paseoHome, "worktrees"));
    const findings = await worktreeCheck.run(ctx, Date.now() + 60_000);

    const size = findings.find((f) => f.id === "worktrees.size");
    expect(size?.title).toBe("5 worktrees on disk, 10.0 GB; 1 with a live agent");
    expect(size?.status).toBe("ok");

    const reclaim = findings.find((f) => f.id === "worktrees.reclaimable");
    expect(reclaim?.status).toBe("warn");
    expect(reclaim?.title).toMatch(/^1 worktree\(s\), 2\.0 GB,/);
    expect(reclaim?.detail).toContain(merged);
    for (const kept of [unmerged, dirty, live, pinned]) expect(reclaim?.detail).not.toContain(kept);
    expect(reclaim?.fix).toContain("paseo worktree archive merged");
    expect(snapshotTree(path.join(fx.paseoHome, "worktrees"))).toEqual(before);
  });

  it("counts a closed or archived agent as not live", async () => {
    const { fx, add } = makeRepoWithWorktrees();
    const wt = add("done");
    const ctx = makeContext(fx, {
      workspaces: [{ cwd: wt, baseBranch: "main", archivedAt: null, pinned: false }],
      agents: [
        { cwd: wt, status: "closed", archived: false },
        { cwd: wt, status: "idle", archived: true },
      ],
    });
    const findings = await worktreeCheck.run(ctx, Date.now() + 60_000);
    expect(findings.some((f) => f.id === "worktrees.reclaimable")).toBe(true);
  });

  it("says the numbers are a floor when the budget runs out before the sweep does", async () => {
    const { fx, add } = makeRepoWithWorktrees();
    for (const name of ["a", "b", "c", "d"]) add(name);
    let calls = 0;
    const ctx = makeContext(
      fx,
      { workspaces: [] },
      {
        probes: fakeProbes({
          measureDirBytes: async () => {
            calls += 1;
            return calls > 2 ? null : 1024 ** 3;
          },
        }),
      },
    );
    const findings = await worktreeCheck.run(ctx, Date.now() + 60_000);
    const size = findings.find((f) => f.id === "worktrees.size");
    expect(size?.status).toBe("warn");
    expect(size?.title).toMatch(/measured 2 of 4/);
    expect(size?.fix).toBe("paseo doctor --deep");
  });

  it("reports an empty worktrees root as fine", async () => {
    const fx = makeFixture();
    const findings = await worktreeCheck.run(makeContext(fx), Date.now() + 1000);
    expect(findings).toEqual([
      expect.objectContaining({ status: "ok", title: "No Paseo worktrees on disk" }),
    ]);
  });
});
