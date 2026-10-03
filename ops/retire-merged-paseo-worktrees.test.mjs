// node --test ops/retire-merged-paseo-worktrees.test.mjs
// The dirt rule of retire-merged-paseo-worktrees.mjs, against temp repos. Importing the script
// doesn't run its sweep, and nothing here talks to the daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { classifyDirt, deleteDisposable, fetchAll } from "./retire-merged-paseo-worktrees.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=someone@example.com", "-c", "user.name=t", ...args], { stdio: "pipe", encoding: "utf8" });
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function worktree() {
  mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(os.homedir(), ".cache", "retire-test-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "packages/app/src"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "packages/app/src/a.ts"), "export {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", wt);
  return { root, repo, wt };
}

function put(wt, file, text = "png") {
  mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  writeFileSync(path.join(wt, file), text);
}

test("a clean worktree has nothing to delete", () => {
  const { wt } = worktree();
  assert.deepEqual(classifyDirt(wt), { ok: true, disposable: [] });
});

test("untracked test captures are disposable, and the worktree then removes cleanly", () => {
  const { repo, wt } = worktree();
  put(wt, "packages/app/.vitest-attachments/4a0a61a1.png");
  put(wt, "packages/app/.vitest-attachments/8b0076c5.png");
  put(wt, ".artifacts/run-1/screen.png");
  put(wt, ".artifacts/notes.txt", "log");
  const dirt = classifyDirt(wt);
  assert.equal(dirt.ok, true);
  assert.deepEqual(dirt.disposable.sort(), [".artifacts/notes.txt", ".artifacts/run-1/screen.png", "packages/app/.vitest-attachments/4a0a61a1.png", "packages/app/.vitest-attachments/8b0076c5.png"]);
  deleteDisposable(wt, dirt.disposable);
  assert.equal(git(wt, "status", "--porcelain", "--untracked-files=all"), "");
  git(repo, "worktree", "remove", wt);
  assert.ok(!existsSync(wt));
});

test("any other dirt keeps the worktree", () => {
  const cases = [
    ["a modified tracked file", (wt) => writeFileSync(path.join(wt, "packages/app/src/a.ts"), "changed\n")],
    ["an untracked source file", (wt) => put(wt, "packages/app/src/b.ts", "x")],
    ["a non-png attachment", (wt) => put(wt, "packages/app/.vitest-attachments/trace.json", "{}")],
    ["a nested attachment", (wt) => put(wt, "packages/app/.vitest-attachments/sub/a.png")],
    ["attachments in another package", (wt) => put(wt, "packages/server/.vitest-attachments/a.png")],
    ["a nested .artifacts", (wt) => put(wt, "packages/app/.artifacts/a.png")],
    [
      "a staged capture",
      (wt) => {
        put(wt, "packages/app/.vitest-attachments/a.png");
        git(wt, "add", "-f", "packages/app/.vitest-attachments/a.png");
      },
    ],
    ["a symlinked .artifacts", (wt, root) => symlinkSync(root, path.join(wt, ".artifacts"))],
    [
      "a nested repo under .artifacts",
      (wt) => {
        mkdirSync(path.join(wt, ".artifacts/clone"), { recursive: true });
        git(path.join(wt, ".artifacts/clone"), "init", "-q");
      },
    ],
  ];
  for (const [what, make] of cases) {
    const { root, wt } = worktree();
    put(wt, "packages/app/.vitest-attachments/ok.png");
    make(wt, root);
    const dirt = classifyDirt(wt);
    assert.equal(dirt.ok, false, what);
    assert.ok(dirt.why, what);
  }
});

test("deleteDisposable refuses a path whose directory resolves outside the worktree, before deleting anything", () => {
  const { root, wt } = worktree();
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep.png"), "precious");
  put(wt, "packages/app/.vitest-attachments/ok.png");
  symlinkSync(outside, path.join(wt, ".artifacts"));
  assert.throws(() => deleteDisposable(wt, ["packages/app/.vitest-attachments/ok.png", ".artifacts/keep.png"]), /resolves outside the worktree/);
  assert.ok(existsSync(path.join(outside, "keep.png")));
  assert.ok(existsSync(path.join(wt, "packages/app/.vitest-attachments/ok.png")), "nothing is deleted when one path is refused");
});

test("deleteDisposable refuses a directory", () => {
  const { wt } = worktree();
  mkdirSync(path.join(wt, ".artifacts/dir"), { recursive: true });
  assert.throws(() => deleteDisposable(wt, [".artifacts/dir"]), /is a directory/);
  assert.ok(existsSync(path.join(wt, ".artifacts/dir")));
});

test("a worktree git can't read throws, which the sweep turns into keep", () => {
  const { root } = worktree();
  assert.throws(() => classifyDirt(path.join(root, "not-a-repo-dir")));
});

test("fetchAll reads every page, and refuses a listing it can't prove complete", async () => {
  const pages = { "": { entries: [1, 2], pageInfo: { hasMore: true, nextCursor: "c1" } }, c1: { entries: [3], pageInfo: { hasMore: false, nextCursor: null } } };
  const seen = [];
  const read = async ({ page }) => {
    seen.push(page);
    return pages[page.cursor ?? ""];
  };
  assert.deepEqual(await fetchAll(read), [1, 2, 3]);
  assert.deepEqual(seen, [{ limit: 200 }, { limit: 200, cursor: "c1" }]);
  await assert.rejects(fetchAll(async () => ({ entries: [1] })), /no pageInfo/);
  await assert.rejects(fetchAll(async () => ({ entries: [1], pageInfo: { hasMore: true, nextCursor: null } })), /without a cursor/);
  await assert.rejects(fetchAll(async () => ({ entries: [1], pageInfo: { hasMore: true, nextCursor: "again" } })), /past 100 pages/);
});
