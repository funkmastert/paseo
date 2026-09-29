// Work-loss audit: find every worktree and branch where work could be lost, and snapshot it.
//
// At risk = uncommitted changes (tracked or untracked), commits on no remote, stashes.
// Snapshot = a commit built through a temporary index (the worktree, its index and HEAD are
// untouched), stored at refs/backup/<date>/<slug>, plus a local git bundle per repo under
// ~/bozeo-ops/backups. Nothing leaves the machine.
//
// There is no --push. On 2026-09-24 `--push` sent every untracked file (a Notion token included)
// and every local-only branch to funkmastert origins, and it would have done the same to the
// public funkmastert/paseo. Offsite copies are the daemon's work snapshots (docs/work-snapshots.md),
// which filter secrets and never push to a public repository.
//
// Usage: node work-audit.mjs [--snapshot]   (report only by default)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";

const HOME = os.homedir();
const DATE = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
const SNAPSHOT = process.argv.includes("--snapshot");
if (process.argv.includes("--push")) {
  console.error(
    "work-audit: --push was removed; it pushed untracked secrets to GitHub on 2026-09-24.\n" +
      "Offsite copies come from the daemon's work snapshots (docs/work-snapshots.md), which filter\n" +
      "secrets and never push to a public repository. Run with --snapshot for local refs and bundles.",
  );
  process.exit(2);
}
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const BACKUP_DIR = path.join(HOME, "bozeo-ops", "backups");

const git = (cwd, args, env = {}) =>
  execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const tryGit = (cwd, args, env) => {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
};

// 1. Candidate directories: every agent cwd, the worktree roots, and top-level repos in ~.
const candidates = new Set();
const c = await connectToDaemon({ host: "127.0.0.1:6767" });
const agents = (await c.fetchAgents({})).entries.map((e) => e.agent);
await c.close();
for (const a of agents) candidates.add(a.cwd);
const scanRoots = [
  path.join(HOME, ".paseo", "worktrees"),
  path.join(HOME, "mobile-worktrees"),
  path.join(HOME, "paseo-worktrees"),
  path.join(HOME, "bn-worktrees"),
  path.join(HOME, "ts-monorepo-worktrees"),
  path.join(HOME, "ParticleFactory-worktrees"),
];
const listDirs = (d) => {
  try {
    return readdirSync(d)
      .map((n) => path.join(d, n))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
};
for (const root of scanRoots) {
  for (const d of listDirs(root)) {
    candidates.add(d);
    for (const dd of listDirs(d)) candidates.add(dd);
  }
}
for (const d of listDirs(HOME)) if (existsSync(path.join(d, ".git"))) candidates.add(d);

// 2. Group into repositories by common git dir; enumerate each repo's worktrees.
const repos = new Map();
for (const dir of candidates) {
  if (!existsSync(dir)) continue;
  const common = tryGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || repos.has(common)) continue;
  const top = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) continue;
  repos.set(common, { common, anyDir: top });
}

const slug = (s) =>
  s
    .replace(/^\/Users\/[^/]+\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
const inside = (root, p) => p === root || p.startsWith(root + "/");

const report = [];
for (const repo of repos.values()) {
  const cwd = repo.anyDir;
  const origin = tryGit(cwd, ["remote", "get-url", "origin"]) ?? "";
  const personal = /github\.com[:/]funkmastert\//.test(origin);
  const hasRemotes = (tryGit(cwd, ["remote"]) ?? "") !== "";
  const repoInfo = {
    repo: repo.common.replace(/\/\.git$/, ""),
    origin,
    personal,
    worktrees: [],
    branches: [],
    stashes: 0,
  };

  // Worktrees.
  const porcelain = tryGit(cwd, ["worktree", "list", "--porcelain"]) ?? "";
  for (const block of porcelain.split("\n\n")) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    if (/^bare$/m.test(block)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    if (!existsSync(wt)) {
      repoInfo.worktrees.push({ path: wt, branch, missing: true });
      continue;
    }
    const status = tryGit(wt, ["status", "--porcelain", "--untracked-files=normal"]) ?? "";
    const dirtyFiles = status ? status.split("\n").length : 0;
    const unpushed = hasRemotes
      ? Number(tryGit(wt, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) ?? 0)
      : Number(tryGit(wt, ["rev-list", "--count", "HEAD"]) ?? 0);
    const liveAgents = agents.filter((a) => !a.archivedAt && inside(wt, a.cwd));
    const entry = {
      path: wt,
      branch,
      detached: /^detached$/m.test(block),
      dirtyFiles,
      unpushed,
      agents: liveAgents.map((a) => ({
        id: a.id.slice(0, 8),
        status: a.status,
        title: a.title,
        updatedAt: a.updatedAt,
        tokens: Math.round(a.totalTokens ?? 0),
      })),
    };
    if (dirtyFiles > 0 || unpushed > 0) entry.atRisk = true;
    repoInfo.worktrees.push(entry);
  }

  // Local branches carrying commits that are on no remote.
  const heads = (tryGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "")
    .split("\n")
    .filter(Boolean);
  for (const b of heads) {
    const n = hasRemotes
      ? Number(tryGit(cwd, ["rev-list", "--count", `refs/heads/${b}`, "--not", "--remotes"]) ?? 0)
      : Number(tryGit(cwd, ["rev-list", "--count", `refs/heads/${b}`]) ?? 0);
    if (n > 0) repoInfo.branches.push({ branch: b, unpushed: n });
  }
  repoInfo.stashes = (tryGit(cwd, ["stash", "list"]) ?? "").split("\n").filter(Boolean).length;
  const agentRoots = [...scanRoots, "/private/tmp", "/tmp"];
  repoInfo.agentRelated =
    repoInfo.worktrees.some((w) => agentRoots.some((r) => inside(r, w.path))) ||
    repoInfo.worktrees.some((w) => agents.some((a) => !a.archivedAt && inside(w.path, a.cwd)));
  if (!repoInfo.repo.startsWith(path.join(HOME, ".nvm"))) report.push(repoInfo);
}

// 3. Snapshot every at-risk worktree through a temporary index.
function snapshot(repoInfo, wt) {
  const tmpIndex = path.join(os.tmpdir(), `audit-index-${process.pid}-${slug(wt.path)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    rmSync(tmpIndex, { force: true });
    git(wt.path, ["read-tree", "HEAD"], env);
    git(wt.path, ["add", "-u"], env);
    const skipped = [];
    const untracked = (tryGit(wt.path, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
      .split("\0")
      .filter(Boolean);
    const keep = [];
    for (const f of untracked) {
      try {
        const size = statSync(path.join(wt.path, f)).size;
        if (size > MAX_UNTRACKED_BYTES) skipped.push(`${f} (${Math.round(size / 1048576)} MB)`);
        else keep.push(f);
      } catch {}
    }
    for (let i = 0; i < keep.length; i += 200)
      git(wt.path, ["add", "--", ...keep.slice(i, i + 200)], env);
    const tree = git(wt.path, ["write-tree"], env);
    const head = git(wt.path, ["rev-parse", "HEAD"]);
    const msg = `backup: snapshot of ${wt.path} on ${DATE}\n\nBranch ${wt.branch ?? "(detached)"}, ${wt.dirtyFiles} changed file(s), ${wt.unpushed} unpushed commit(s).${skipped.length ? `\nSkipped large untracked files: ${skipped.join(", ")}` : ""}`;
    const commit = git(wt.path, ["commit-tree", tree, "-p", head, "-m", msg]);
    const ref = `refs/backup/${DATE}/${slug(wt.path)}`;
    git(wt.path, ["update-ref", ref, commit]);
    return { ref, commit: commit.slice(0, 9), skipped };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

if (SNAPSHOT) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  for (const repoInfo of report) {
    if (!repoInfo.agentRelated) continue;
    const refs = [];
    for (const wt of repoInfo.worktrees) {
      if (!wt.atRisk || wt.missing) continue;
      try {
        wt.snapshot = snapshot(repoInfo, wt);
        refs.push(wt.snapshot.ref);
      } catch (e) {
        wt.snapshotError = String(e.stderr ?? e.message).split("\n")[0];
      }
    }
    // Unpushed branches with no worktree are already refs; include them in the backup too.
    for (const b of repoInfo.branches) refs.push(`refs/heads/${b.branch}`);
    if (refs.length === 0) continue;
    const cwd = repoInfo.worktrees.find((w) => !w.missing)?.path ?? repoInfo.repo;
    const bundle = path.join(BACKUP_DIR, `${slug(repoInfo.repo)}-${DATE}.bundle`);
    try {
      git(cwd, ["bundle", "create", bundle, ...refs]);
      repoInfo.bundle = bundle;
    } catch (e) {
      repoInfo.bundleError = String(e.stderr ?? e.message).split("\n")[0];
    }
  }
}

writeFileSync(
  path.join(HOME, "bozeo-ops", "work-audit.json"),
  JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
);

// Summary.
for (const r of report) {
  const risky = r.worktrees.filter((w) => w.atRisk || w.missing);
  if (risky.length === 0 && r.branches.length === 0 && r.stashes === 0) continue;
  console.log(
    `\n## ${r.repo.replace(HOME, "~")}${r.agentRelated ? "" : "  (no agent involvement; report only)"}  [${r.personal ? "personal GitHub" : r.origin ? r.origin.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, "$1") : "no remote"}]`,
  );
  for (const w of risky) {
    const who = (w.agents ?? []).length
      ? w.agents.map((a) => `${a.id} ${a.status}`).join(", ")
      : "no agent";
    const snap = w.snapshot
      ? ` → ${w.snapshot.commit}${w.snapshot.skipped.length ? ` (skipped ${w.snapshot.skipped.length} large)` : ""}`
      : w.snapshotError
        ? ` → SNAPSHOT FAILED: ${w.snapshotError}`
        : "";
    console.log(
      `  ${w.missing ? "MISSING" : "wt"} ${w.path.replace(HOME, "~")} [${w.branch ?? "detached"}] dirty=${w.dirtyFiles ?? "-"} unpushed=${w.unpushed ?? "-"} | ${who}${snap}`,
    );
  }
  const loose = r.branches.filter((b) => !r.worktrees.some((w) => w.branch === b.branch));
  if (loose.length)
    console.log(
      `  local-only branches without a worktree: ${loose.map((b) => `${b.branch}(${b.unpushed})`).join(", ")}`,
    );
  if (r.stashes) console.log(`  stashes: ${r.stashes}`);
  if (r.bundle) console.log(`  bundle: ${r.bundle.replace(HOME, "~")}`);
  if (r.bundleError) console.log(`  BUNDLE FAILED: ${r.bundleError}`);
}
console.log(`\n${report.length} repositories scanned; details in ~/bozeo-ops/work-audit.json`);
process.exit(0);
