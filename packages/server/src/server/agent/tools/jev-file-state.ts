import { execFile } from "node:child_process";
import { existsSync, constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createExternalProcessEnv } from "../../paseo-env.js";
import { isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import { resolvePaseoWorktreesBaseRoot } from "../../../utils/worktree.js";

/**
 * How the JEV agent tools read files (docs/jev.md, "Reading files safely"). A JEV tool never
 * reads what the agent's own tools may not, and never ships what a person would not want shipped:
 * code resolves, confines, expands and prunes here, and only what survives becomes a JEV state.
 */

/** A file over this is refused, never cut: JEV's state cap is 60 KB and the questions need room. */
export const JEV_FILE_MAX_BYTES = 60_000;
/** `ask_jev_files` asks one JEV call per file; more than this is a pattern to narrow. */
export const JEV_FILES_CAP = 120;
const BINARY_PROBE_BYTES = 8192;
/** A directory walk outside git stops here, so a pattern over a huge tree cannot stall the daemon. */
const MAX_WALK_ENTRIES = 20_000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

/** The reference's binary and lock extensions (level09/prune.ts), plus a few more of each. */
const BINARY_OR_LOCK_RE =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|heic|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|aar|apk|ipa|dmg|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|flac|mov|avi|mkv|webm|so|dylib|dll|exe|bin|o|a|class|wasm|pyc|sqlite3?|db|lock|lockb)$/i;
const LOCK_FILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "go.sum",
]);

/**
 * Secret-shaped names (docs/jev.md, "Reading files safely"). The agent can still Read any of
 * them; the tools only decline to send them to a third party. One list feeds both checks: the
 * name check here and the `:(exclude,glob,icase)` pathspecs `git diff` gets, so a diff leaves out
 * exactly what a read refuses. Matched case-insensitively both ways: macOS and Windows volumes
 * fold case, and `Credentials.json` is the same secret as `credentials.json`.
 */
export const SECRET_PATHSPEC_GLOBS = [
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.p8",
  "*.jks",
  "*.keystore",
  "*.mobileprovision",
  "*.tfvars",
  "*.tfstate",
  "*.tfstate.*",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  "credentials*",
  ".credentials*",
  "hosts.yml",
  "kubeconfig",
  ".docker/config.json",
  "google-services.json",
  "GoogleService-Info.plist",
  "local.properties",
  "keystore.properties",
] as const;

/** A glob's `*` matches any run of characters within one path segment, dots included, as in git. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`(^|/)${body}$`, "i");
}

const SECRET_NAME_RES = SECRET_PATHSPEC_GLOBS.map(globToRegExp);

export function isSecretShapedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return SECRET_NAME_RES.some((re) => re.test(normalized));
}

export function isBinaryOrLockPath(filePath: string): boolean {
  const base = path.basename(filePath);
  return BINARY_OR_LOCK_RE.test(base) || LOCK_FILE_NAMES.has(base.toLowerCase());
}

export interface JevGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type JevGitRunner = (
  args: string[],
  options: { cwd: string; input?: string },
) => Promise<JevGitResult>;

/** Git for Windows maps `/dev/null` to `NUL`, so one spelling serves both. */
const NULL_DEVICE = "/dev/null";

/**
 * The config keys a repository could set to make these read-only git calls run a program, each
 * overridden on the command line, which outranks the repository's own config. Most cannot fire
 * on `rev-parse`, `ls-files`, `check-ignore`, a tree-to-tree `diff --no-ext-diff --no-textconv`
 * or `log --no-show-signature`; they are listed so a future flag or git version does not quietly
 * reopen one. An agent that can Edit `.git/config` would otherwise run code as the daemon,
 * outside its sandbox, its Bash denial and the catastrophe gate.
 */
const NEUTRAL_GIT_CONFIG = [
  // A lazy fetch of a missing blob (`extensions.partialClone`) is the one confirmed path: it runs
  // the transport, which runs `core.sshCommand`, an `ext::` helper or a credential helper.
  // GIT_NO_LAZY_FETCH and GIT_ALLOW_PROTOCOL in the env close it; these are the second guard. A
  // repository's `protocol.<name>.allow` outranks `protocol.allow`, so the env is the real one.
  "protocol.allow=never",
  "core.sshCommand=",
  "core.gitProxy=",
  "core.askPass=",
  "credential.helper=",
  "core.alternateRefsCommand=",
  "core.fsmonitor=false",
  `core.hooksPath=${NULL_DEVICE}`,
  "core.pager=cat",
  `core.attributesFile=${NULL_DEVICE}`,
  "diff.external=",
  "log.showSignature=false",
  "gpg.program=",
  "gpg.openpgp.program=",
  "gpg.x509.program=",
  "gpg.ssh.program=",
];

/** Per-driver and per-name keys, found by a read of the repository's config before each call. */
const DRIVER_KEY_RE =
  /^(?:(?:filter|diff|merge)\..+\.(?:process|clean|smudge|textconv|command|driver)|credential\..+\.helper|protocol\..+\.allow|gpg\..+\.program)$/i;
const DRIVER_KEY_PATTERN =
  "^(filter|diff|merge)\\..*\\.(process|clean|smudge|textconv|command|driver)$|^credential\\..*\\.helper$|^protocol\\..*\\.allow$|^gpg\\..*\\.program$|^core\\.excludesfile$";

/**
 * The environment every JEV git call runs with: the daemon's, minus the JEV key and every
 * inherited `GIT_*` variable (a parent git process or hook sets `GIT_DIR` and friends, and
 * `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF` or `GIT_CONFIG_PARAMETERS` would name programs), with
 * lazy fetch and every transport off and only the repository's own config read.
 */
export function jevGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = createExternalProcessEnv(baseEnv);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    // A list overrides every `protocol.*.allow` in config; no transport has this name.
    GIT_ALLOW_PROTOCOL: "paseo-jev-no-transport",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "cat",
  };
}

function execGit(
  args: string[],
  options: { cwd: string; input?: string; env: NodeJS.ProcessEnv },
): Promise<JevGitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // A non-zero exit carries the exit status as a number; a spawn failure carries a string.
        const status = (error as { code?: unknown } | null)?.code;
        let code: number | null = null;
        if (error === null) code = 0;
        else if (typeof status === "number") code = status;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Reads the keys the overrides must also cover, with the hardened env (reading config runs
 * nothing), plus the user's global `core.excludesFile`: `GIT_CONFIG_GLOBAL` drops the global
 * file, and with it a person's global ignores, which decide what the tools treat as ignored.
 */
async function readConfigOverrides(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<string[] | { refused: string }> {
  const env = jevGitEnv(baseEnv);
  delete env["GIT_CONFIG_GLOBAL"];
  const listed = await execGit(
    ["config", "--null", "--show-scope", "--get-regexp", DRIVER_KEY_PATTERN],
    { cwd, env },
  );
  // 1: no key matched. Anything else but 0 is a config git cannot read; the call then fails too.
  if (listed.code !== 0) return [];
  const overrides: string[] = [];
  // `--null --show-scope`: scope NUL key LF value NUL, per entry.
  const fields = listed.stdout.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]!;
    const entry = fields[i + 1]!;
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? "" : entry.slice(newline + 1);
    if (key.toLowerCase() === "core.excludesfile") {
      if (scope === "global" && value) {
        overrides.push(`core.excludesFile=${expandHome(value, baseEnv)}`);
      }
      continue;
    }
    if (!DRIVER_KEY_RE.test(key)) continue;
    // `-c` splits at the first `=`; a key holding one cannot be overridden, so git is not run.
    if (key.includes("=")) {
      return { refused: `a config key git cannot override: ${key.slice(0, 80)}` };
    }
    overrides.push(`${key}=${/^protocol\./i.test(key) ? "never" : ""}`);
  }
  return overrides;
}

function expandHome(file: string, env: NodeJS.ProcessEnv): string {
  if (file !== "~" && !file.startsWith("~/")) return file;
  return path.join(env["HOME"] ?? os.homedir(), file.slice(1));
}

/**
 * A git runner for the JEV tools: argv only, no shell, `LC_ALL=C` so "not a git repository"
 * reads the same everywhere, and nothing a repository's config names ever runs.
 */
export function createJevGitRunner(options: { baseEnv?: NodeJS.ProcessEnv } = {}): JevGitRunner {
  return async (args, runOptions) => {
    const baseEnv = options.baseEnv ?? process.env;
    const overrides = await readConfigOverrides(runOptions.cwd, baseEnv);
    if (!Array.isArray(overrides)) return { code: 128, stdout: "", stderr: overrides.refused };
    const config = [...NEUTRAL_GIT_CONFIG, ...overrides].flatMap((entry) => ["-c", entry]);
    return execGit(["--no-pager", ...config, ...args], {
      cwd: runOptions.cwd,
      input: runOptions.input,
      env: jevGitEnv(baseEnv),
    });
  };
}

export const runJevGit: JevGitRunner = createJevGitRunner();

/** What the agent's own configuration says it may not read. */
export interface JevReadDenials {
  /** `Read` itself is denied (`paseo.tools-denied`, `disallowedTools`, a bare `Read` rule). */
  all: boolean;
  /** `Read(<pattern>)` rules and `sandbox.filesystem.denyRead` entries, as written. */
  patterns: string[];
}

export interface JevFileAccessOptions {
  /** The caller agent's recorded cwd. */
  cwd: string;
  homeDir?: string;
  paseoHome: string;
  /** `worktreesRoot` from the daemon config; defaults to `$PASEO_HOME/worktrees`. */
  worktreesRoot?: string;
  platform?: NodeJS.Platform;
  denials?: JevReadDenials;
  runGit?: JevGitRunner;
}

export interface JevFileSkip {
  path: string;
  reason: string;
}

/** A path that passed every rule and may be read. */
export interface JevFileRef {
  /** As the agent should see it: relative to cwd when inside it. */
  path: string;
  /** Resolved against the recorded cwd, before symlinks. */
  absolutePath: string;
  realPath: string;
  /** The real path's identity when it was checked; `read` refuses a file that is no longer it. */
  dev: number;
  ino: number;
}

export interface JevFileContent extends JevFileRef {
  content: string;
  bytes: number;
}

export type JevFileScopeResult = { ok: true; scope: JevFileScope } | { ok: false; reason: string };

const GLOB_CHARS_RE = /[*?[\]{}]/;

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

const DATA_VOLUME = "/system/volumes/data";

/**
 * The spelling every comparison uses. `fs.realpath` keeps macOS's `/System/Volumes/Data` firmlink
 * prefix, so `/System/Volumes/Data/Users/x` and `/Users/x` are one directory with two names; and
 * macOS and Windows volumes fold case. Without both, a cwd spelled the other way slips past the
 * home refusal and every denied root.
 */
export function canonicalJevPath(value: string, platform: NodeJS.Platform): string {
  let out = value;
  if (platform === "darwin") {
    const lower = out.toLowerCase();
    if (lower === DATA_VOLUME || lower === `${DATA_VOLUME}/`) out = "/";
    else if (lower.startsWith(`${DATA_VOLUME}/`)) out = out.slice(DATA_VOLUME.length);
  }
  return foldsCase(platform) ? out.toLowerCase() : out;
}

function samePathOrBelow(base: string, candidate: string, platform: NodeJS.Platform): boolean {
  return isSameOrDescendantPath(
    canonicalJevPath(base, platform),
    canonicalJevPath(candidate, platform),
  );
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * The file tools' view of one caller's cwd. Build it per tool call with `openJevFileScope`: it
 * realpaths the cwd, refuses the cwds the tools never read from, and asks git once whether the cwd
 * is a work tree.
 */
export class JevFileScope {
  private constructor(
    private readonly options: Required<Omit<JevFileAccessOptions, "denials">> & {
      denials: JevReadDenials;
    },
    readonly realCwd: string,
    readonly gitTop: string | null,
    private readonly deniedRoots: DeniedRoot[],
    private readonly worktreeRoots: string[],
    private readonly realHome: string,
  ) {}

  static async open(options: JevFileAccessOptions): Promise<JevFileScopeResult> {
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? os.homedir();
    const denials = options.denials ?? { all: false, patterns: [] };
    const runGit = options.runGit ?? runJevGit;
    if (denials.all) {
      return {
        ok: false,
        reason: "your denied tools include Read, so the JEV file tools do not read files for you",
      };
    }
    const realCwd = await realpathOrNull(options.cwd);
    if (!realCwd) return { ok: false, reason: "your working directory does not exist" };
    const realHome = (await realpathOrNull(homeDir)) ?? homeDir;
    const canonicalCwd = canonicalJevPath(realCwd, platform);
    if (
      canonicalCwd === canonicalJevPath(path.parse(realCwd).root, platform) ||
      samePathOrBelow(realCwd, realHome, platform) ||
      samePathOrBelow(realCwd, homeDir, platform)
    ) {
      return {
        ok: false,
        reason:
          "the JEV file tools do not read from your home directory, an ancestor of it, or the filesystem root; run from a project directory",
      };
    }
    const deniedRoots = await resolveDeniedRoots(homeDir, options.paseoHome);
    const worktreeRoots = await resolveWorktreeRoots(
      options.paseoHome,
      options.worktreesRoot,
      platform,
    );
    // The carve-out is for reading inside one worktree, not for listing every worktree there is:
    // a cwd that is the worktrees root itself would otherwise see every other agent's worktree as
    // "inside its own working directory," with the paseoHome denial carved out for all of them (m6).
    if (worktreeRoots.some((root) => canonicalCwd === canonicalJevPath(root, platform))) {
      return {
        ok: false,
        reason:
          "the JEV file tools do not read from the worktrees root itself; run from a worktree",
      };
    }
    const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: realCwd });
    const gitTop = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
    return {
      ok: true,
      scope: new JevFileScope(
        {
          cwd: options.cwd,
          homeDir,
          paseoHome: options.paseoHome,
          worktreesRoot: options.worktreesRoot ?? "",
          platform,
          denials,
          runGit,
        },
        realCwd,
        gitTop,
        deniedRoots,
        worktreeRoots,
        realHome,
      ),
    };
  }

  get cwd(): string {
    return this.options.cwd;
  }

  /** The paths a glob, a directory or a named file stands for. Globs are relative to cwd. */
  async expand(
    patterns: string[],
    options: { recursive: boolean },
  ): Promise<{ paths: string[]; skipped: JevFileSkip[] }> {
    const out = new Set<string>();
    const skipped: JevFileSkip[] = [];
    const listing = new CandidateListing(() => this.listCandidates());
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (!pattern) continue;
      let matched: string[] | JevFileSkip;
      if (pattern.includes("\0")) matched = { path: pattern, reason: "not a path" };
      else if (GLOB_CHARS_RE.test(pattern)) matched = await this.expandGlob(pattern, listing);
      else matched = await this.expandNamed(pattern, listing, options.recursive);
      if (!Array.isArray(matched)) {
        skipped.push(matched);
        continue;
      }
      for (const file of matched) out.add(file);
    }
    return { paths: [...out].sort(), skipped };
  }

  private async expandGlob(
    pattern: string,
    listing: CandidateListing,
  ): Promise<string[] | JevFileSkip> {
    const glob = toPosix(pattern).replace(/^\.\//, "");
    if (path.isAbsolute(pattern) || glob.startsWith("~") || glob.split("/").includes("..")) {
      return { path: pattern, reason: "globs must be relative to your working directory" };
    }
    const files = await listing.get();
    if (!Array.isArray(files)) return { path: pattern, reason: files.reason };
    const matched = files.filter((file) => path.posix.matchesGlob(file, glob));
    return matched.length > 0 ? matched : { path: pattern, reason: "no files match" };
  }

  /** A named file stays as named, for `prune` to judge; a directory becomes its files. */
  private async expandNamed(
    pattern: string,
    listing: CandidateListing,
    recursive: boolean,
  ): Promise<string[] | JevFileSkip> {
    const absolute = resolvePathFromBase(this.cwd, pattern);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isDirectory()) return [pattern];
    const real = await realpathOrNull(absolute);
    if (!real || !samePathOrBelow(this.realCwd, real, this.options.platform)) {
      return { path: pattern, reason: "outside your working directory" };
    }
    const files = await listing.get();
    if (!Array.isArray(files)) return { path: pattern, reason: files.reason };
    const prefix = toPosix(path.relative(this.realCwd, real));
    const matched = files.filter((file) => {
      if (prefix && !file.startsWith(`${prefix}/`)) return false;
      const rest = prefix ? file.slice(prefix.length + 1) : file;
      return rest.length > 0 && (recursive || !rest.includes("/"));
    });
    return matched.length > 0 ? matched : { path: pattern, reason: "no files in the directory" };
  }

  /**
   * Every rule except reading: confinement, denied roots, the agent's own read denials, secret
   * names, binary and lock files, git-ignored names. Returns the survivors in order, each at most
   * once, capped at `cap`.
   */
  async prune(
    paths: string[],
    cap: number,
  ): Promise<{ files: JevFileRef[]; skipped: JevFileSkip[] }> {
    const files: JevFileRef[] = [];
    const skipped: JevFileSkip[] = [];
    const seen = new Set<string>();
    const candidates: JevFileRef[] = [];
    for (const requested of paths) {
      const verdict = await this.resolveOne(requested);
      if ("reason" in verdict) {
        skipped.push(verdict);
        continue;
      }
      if (seen.has(verdict.realPath)) continue;
      seen.add(verdict.realPath);
      candidates.push(verdict);
    }
    const ignored = await this.ignoredByGit(candidates);
    for (const candidate of candidates) {
      if (ignored === "error") {
        skipped.push({ path: candidate.path, reason: "git could not say whether it is ignored" });
        continue;
      }
      if (ignored.has(candidate.realPath)) {
        skipped.push({ path: candidate.path, reason: "ignored by git; Read it if you need it" });
        continue;
      }
      if (files.length >= cap) {
        skipped.push({
          path: candidate.path,
          reason: `over the ${cap} file cap; narrow the pattern`,
        });
        continue;
      }
      files.push(candidate);
    }
    return { files, skipped };
  }

  /**
   * Reads a pruned file. Opens the real path with `O_NOFOLLOW` and compares the handle's device and
   * inode with the ones `prune` checked, so a swap between the check and the read is caught.
   */
  async read(ref: JevFileRef): Promise<JevFileContent | JevFileSkip> {
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let handle: import("node:fs/promises").FileHandle;
    try {
      handle = await fs.open(ref.realPath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: ref.path, reason: "not found" };
      return { path: ref.path, reason: CHANGED_REASON };
    }
    try {
      const stat = await handle.stat();
      // Windows can report 0 for both on some volumes; there the realpath check stands alone.
      const identified = ref.ino !== 0 || ref.dev !== 0;
      if (identified && (stat.ino !== ref.ino || stat.dev !== ref.dev)) {
        return { path: ref.path, reason: CHANGED_REASON };
      }
      if (!stat.isFile()) return { path: ref.path, reason: "not a file" };
      if (stat.size === 0) return { path: ref.path, reason: "empty" };
      if (stat.size > JEV_FILE_MAX_BYTES) return { path: ref.path, reason: tooLarge(stat.size) };
      const buffer = Buffer.alloc(JEV_FILE_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > JEV_FILE_MAX_BYTES) return { path: ref.path, reason: tooLarge(length) };
      if (length === 0) return { path: ref.path, reason: "empty" };
      const data = buffer.subarray(0, length);
      if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        return { path: ref.path, reason: "binary" };
      }
      return { ...ref, content: data.toString("utf8"), bytes: length };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Whether a path is one the tools never send whatever the call: a denied root or one of the
   * agent's own read rules. For content that reaches JEV without being read here, like a diff.
   */
  deniedReason(absolutePath: string): string | null {
    if (this.inDeniedRoot(absolutePath)) return DENIED_ROOT_REASON;
    if (this.deniedByAgent(absolutePath)) return AGENT_DENIED_REASON;
    return null;
  }

  private async resolveOne(requested: string): Promise<JevFileRef | JevFileSkip> {
    const shown = requested.trim();
    if (!shown || shown.includes("\0")) return { path: requested, reason: "not a path" };
    const { platform } = this.options;
    const absolutePath = resolvePathFromBase(this.cwd, shown);
    // Denied roots and secret names are judged on the path as named too, so a symlink out of a
    // denied root or onto a secret-shaped name is refused either way.
    if (this.inDeniedRoot(absolutePath)) return { path: shown, reason: DENIED_ROOT_REASON };
    if (isSecretShapedPath(absolutePath)) return { path: shown, reason: SECRET_NAME_REASON };
    const realPath = await realpathOrNull(absolutePath);
    if (!realPath) return { path: shown, reason: "not found" };
    if (!samePathOrBelow(this.realCwd, realPath, platform)) {
      return { path: shown, reason: "outside your working directory" };
    }
    if (this.inDeniedRoot(realPath)) return { path: shown, reason: DENIED_ROOT_REASON };
    if (isSecretShapedPath(realPath)) return { path: shown, reason: SECRET_NAME_REASON };
    if (this.deniedByAgent(absolutePath) || this.deniedByAgent(realPath)) {
      return { path: shown, reason: AGENT_DENIED_REASON };
    }
    if (isBinaryOrLockPath(realPath)) return { path: shown, reason: "binary or lock file" };
    const stat = await fs.stat(realPath).catch(() => null);
    if (!stat) return { path: shown, reason: "not found" };
    if (!stat.isFile()) return { path: shown, reason: "not a file" };
    // A hard link's real path is inside cwd whatever the other name is: it could be anything.
    if (stat.nlink > 1) return { path: shown, reason: HARD_LINK_REASON };
    if (stat.size === 0) return { path: shown, reason: "empty" };
    if (stat.size > JEV_FILE_MAX_BYTES) return { path: shown, reason: tooLarge(stat.size) };
    const relative = toPosix(path.relative(this.realCwd, realPath));
    return { path: relative || shown, absolutePath, realPath, dev: stat.dev, ino: stat.ino };
  }

  private inDeniedRoot(candidate: string): boolean {
    const { platform, homeDir } = this.options;
    const inWorktree = this.worktreeRoots.some((root) =>
      samePathOrBelow(root, candidate, platform),
    );
    const denied = this.deniedRoots.some(
      (root) =>
        samePathOrBelow(root.path, candidate, platform) && !(root.worktreesCarveOut && inWorktree),
    );
    if (denied) return true;
    // `~/.claude*`: every Claude config dir, one per account.
    const canonical = canonicalJevPath(candidate, platform);
    return [homeDir, this.realHome].some((home) => {
      const relative = path.relative(canonicalJevPath(home, platform), canonical);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
      const first = relative.split(/[\\/]/)[0] ?? "";
      return first.toLowerCase().startsWith(".claude");
    });
  }

  private deniedByAgent(candidate: string): boolean {
    const { denials, homeDir, platform } = this.options;
    const a = toPosix(canonicalJevPath(candidate, platform));
    return denials.patterns.some((raw) => {
      const pattern = normalizeDenyPattern(raw, { cwd: this.cwd, homeDir });
      if (!pattern) return false;
      const p = toPosix(canonicalJevPath(pattern, platform));
      if (!GLOB_CHARS_RE.test(p)) return samePathOrBelow(p, a, platform);
      // `matchesGlob` never lets `*` match a leading dot. Denying too much is the safe side here,
      // so the path is also tried with each segment's leading dot dropped.
      const undotted = a.replace(/\/\./g, "/");
      const below = `${p.replace(/\/+$/, "")}/**`;
      return [a, undotted].some(
        (candidatePath) =>
          path.posix.matchesGlob(candidatePath, p) || path.posix.matchesGlob(candidatePath, below),
      );
    });
  }

  /** Every file under cwd the tools may consider: git's view in a work tree, a pruned walk outside. */
  private async listCandidates(): Promise<string[] | JevFileSkip> {
    if (this.gitTop) {
      const listed = await this.options.runGit(
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: this.realCwd },
      );
      if (listed.code !== 0) return { path: this.cwd, reason: "git could not list the files" };
      return listed.stdout.split("\0").filter((entry) => entry.length > 0);
    }
    return this.walk();
  }

  private async walk(): Promise<string[] | JevFileSkip> {
    const out: string[] = [];
    const queue: string[] = [""];
    let visited = 0;
    while (queue.length > 0) {
      const relativeDir = queue.shift()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(path.join(this.realCwd, relativeDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_WALK_ENTRIES) {
          return {
            path: this.cwd,
            reason: `the directory walk stopped at ${MAX_WALK_ENTRIES} entries; narrow the pattern`,
          };
        }
        const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name)) continue;
          queue.push(relative);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          out.push(relative);
        }
      }
    }
    return out;
  }

  /** Real paths git reports as ignored. Outside a work tree nothing is. Any git error is "error". */
  private async ignoredByGit(candidates: JevFileRef[]): Promise<Set<string> | "error"> {
    if (!this.gitTop || candidates.length === 0) return new Set();
    // Relative to cwd, which git resolves itself: an absolute path in another spelling of the
    // same directory (the `/System/Volumes/Data` firmlink, a Windows drive letter's case) is
    // "outside the repository" to git.
    const byInput = new Map<string, string>();
    for (const candidate of candidates) {
      byInput.set(toPosix(path.relative(this.realCwd, candidate.realPath)), candidate.realPath);
    }
    const result = await this.options.runGit(["check-ignore", "--stdin", "-z"], {
      cwd: this.realCwd,
      input: `${[...byInput.keys()].join("\0")}\0`,
    });
    // 0: some are ignored, 1: none are, anything else: git could not tell.
    if (result.code === 1) return new Set();
    if (result.code !== 0) return "error";
    const ignored = new Set<string>();
    for (const entry of result.stdout.split("\0")) {
      if (!entry) continue;
      const real = byInput.get(toPosix(entry));
      if (real) ignored.add(real);
    }
    return ignored;
  }
}

/** The candidate list, fetched once per `expand` and only when a glob or directory needs it. */
class CandidateListing {
  private listed: Promise<string[] | JevFileSkip> | null = null;

  constructor(private readonly load: () => Promise<string[] | JevFileSkip>) {}

  get(): Promise<string[] | JevFileSkip> {
    this.listed ??= this.load();
    return this.listed;
  }
}

const DENIED_ROOT_REASON = "a private directory the JEV tools never read";
const AGENT_DENIED_REASON = "your own read rules deny it";
const CHANGED_REASON = "changed while being read; Read it instead";
const HARD_LINK_REASON = "a hard link, whose other names could be anywhere; Read it if you need it";
const SECRET_NAME_REASON =
  "secret-shaped name; Read it if you need it, the JEV tools do not send it";

function tooLarge(bytes: number): string {
  return `over ${JEV_FILE_MAX_BYTES.toLocaleString("en-US")} bytes (${bytes.toLocaleString("en-US")}); use Read or grep`;
}

interface DeniedRoot {
  path: string;
  /** `$PASEO_HOME`: its worktrees are repositories an agent works in, not the daemon's state. */
  worktreesCarveOut: boolean;
}

async function withRealPaths(paths: string[]): Promise<string[]> {
  const out = new Set<string>(paths);
  for (const entry of paths) {
    const real = await realpathOrNull(entry);
    if (real) out.add(real);
  }
  return [...out];
}

async function resolveDeniedRoots(homeDir: string, paseoHome: string): Promise<DeniedRoot[]> {
  const home = [".config", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "Library"].map((name) =>
    path.join(homeDir, name),
  );
  return [
    ...(await withRealPaths([paseoHome])).map((root) => ({ path: root, worktreesCarveOut: true })),
    ...(await withRealPaths(home)).map((root) => ({ path: root, worktreesCarveOut: false })),
  ];
}

/**
 * `worktreesRoot` when configured, else `$PASEO_HOME/worktrees` (`resolvePaseoWorktreesBaseRoot`).
 * The config loader already refuses a `worktreesRoot` that equals or contains `$PASEO_HOME` (m6):
 * carved out, it would widen the denial's exception to every other agent's config and secrets
 * under `$PASEO_HOME`, not only worktrees. Checked again here in case a caller reaches this with
 * one some other way; dropping it leaves no carve-out rather than guessing a safe substitute.
 */
async function resolveWorktreeRoots(
  paseoHome: string,
  worktreesRoot: string | undefined,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const roots = await withRealPaths([
    resolvePaseoWorktreesBaseRoot({ paseoHome, ...(worktreesRoot ? { worktreesRoot } : {}) }),
  ]);
  return roots.filter((root) => !samePathOrBelow(root, paseoHome, platform));
}

/**
 * Claude's rule forms: `//abs` is absolute, `~/x` is under home, `/x` and `./x` and `x/y` are
 * relative to the project (here the agent's cwd), and a bare name with no slash matches at any
 * depth, as in gitignore.
 */
function normalizeDenyPattern(raw: string, context: { cwd: string; homeDir: string }): string {
  const pattern = raw.trim();
  if (!pattern) return "";
  if (pattern.startsWith("//")) return pattern.slice(1);
  if (pattern === "~" || pattern.startsWith("~/"))
    return path.join(context.homeDir, pattern.slice(2));
  if (path.isAbsolute(pattern) && !pattern.startsWith("/")) return pattern;
  if (pattern.startsWith("/")) return path.join(context.cwd, pattern.slice(1));
  if (pattern.startsWith("./")) return path.join(context.cwd, pattern.slice(2));
  if (!pattern.includes("/")) return path.join(context.cwd, "**", pattern);
  return path.join(context.cwd, pattern);
}

/** One Claude settings file: its parsed JSON, and the project root it governs when it is a project's. */
export interface ClaudeSettingsFile {
  path: string;
  /** `<root>/.claude/settings*.json` governs `root`; account and managed settings govern no root. */
  root: string | null;
  settings: unknown;
}

export interface CallerDenials {
  read: JevReadDenials;
  bashDenied: boolean;
  sandboxed: boolean;
  /** A PreToolUse hook in a settings file matches Bash: it runs on the agent's Bash, not here. */
  bashHooked: boolean;
}

/**
 * Collects what the caller's configuration denies: `paseo.tools-denied`, and for Claude agents
 * `disallowedTools`, `settings.permissions.deny`, both `sandbox.filesystem.denyRead` lists, and
 * whether either sandbox is on; then the same keys, plus PreToolUse hooks on Bash, from the
 * Claude settings files the CLI itself reads (`readClaudeSettingsFiles`).
 * Anything it cannot parse is ignored; the agent's own tools enforce those rules either way.
 */
export function readCallerDenials(input: {
  toolsDeniedLabel: string | undefined;
  providerOptions: unknown;
  settingsFiles?: readonly ClaudeSettingsFile[];
}): CallerDenials {
  const files = input.settingsFiles ?? [];
  const toolRules: Array<{ rule: string; root: string | null }> = [
    ...(input.toolsDeniedLabel ?? "").split(","),
    ...stringArray(pick(input.providerOptions, ["disallowedTools"])),
    ...stringArray(pick(input.providerOptions, ["settings", "permissions", "deny"])),
  ].map((rule) => ({ rule, root: null }));
  const patterns = [
    ...stringArray(pick(input.providerOptions, ["sandbox", "filesystem", "denyRead"])),
    ...stringArray(pick(input.providerOptions, ["settings", "sandbox", "filesystem", "denyRead"])),
  ];
  let sandboxed =
    pick(input.providerOptions, ["sandbox", "enabled"]) === true ||
    pick(input.providerOptions, ["settings", "sandbox", "enabled"]) === true;
  let bashHooked = false;
  for (const file of files) {
    for (const rule of stringArray(pick(file.settings, ["permissions", "deny"]))) {
      toolRules.push({ rule, root: file.root });
    }
    for (const entry of stringArray(pick(file.settings, ["sandbox", "filesystem", "denyRead"]))) {
      patterns.push(rootedPattern(entry, file.root));
    }
    if (pick(file.settings, ["sandbox", "enabled"]) === true) sandboxed = true;
    if (hooksBash(pick(file.settings, ["hooks", "PreToolUse"]))) bashHooked = true;
  }
  let all = false;
  let bashDenied = false;
  for (const { rule: raw, root } of toolRules) {
    const rule = raw.trim();
    if (rule === "Read") all = true;
    const scoped = /^Read\((.*)\)$/s.exec(rule);
    if (scoped) {
      const spec = scoped[1]!.trim();
      if (spec === "" || spec === "*" || spec === "**" || spec === "//**") all = true;
      else patterns.push(rootedPattern(spec, root));
    }
    // A command-scoped Bash rule is refused whole: code cannot tell which commands it covers.
    if (rule === "Bash" || rule.startsWith("Bash(")) bashDenied = true;
  }
  return { read: { all, patterns }, bashDenied, sandboxed, bashHooked };
}

/**
 * A project settings file's relative rule is relative to the project it sits in, which is not
 * always the agent's cwd; it becomes absolute (`//…`). Bare names, `~/` and `//` stay as written.
 */
function rootedPattern(spec: string, root: string | null): string {
  const pattern = spec.trim();
  if (!root || pattern.startsWith("//") || pattern === "~" || pattern.startsWith("~/")) {
    return pattern;
  }
  if (!pattern.includes("/")) return pattern;
  const absolute = path.join(root, pattern.replace(/^\.?\//, ""));
  return absolute.startsWith("/") ? `/${absolute}` : absolute;
}

/** A PreToolUse matcher that is empty, `*`, or a pattern `Bash` matches, as the CLI reads it. */
function hooksBash(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const matcher = pick(entry, ["matcher"]);
    if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
    if (typeof matcher !== "string") return true;
    try {
      return new RegExp(`^(?:${matcher})$`).test("Bash");
    } catch {
      // A matcher the CLI might read differently: assume it covers Bash.
      return true;
    }
  });
}

/** Where the CLI reads managed settings, per platform. */
export function defaultClaudeManagedSettingsPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin")
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") {
    return [
      "C:\\Program Files\\ClaudeCode\\managed-settings.json",
      "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
    ];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

/**
 * The Claude settings files whose deny rules, sandbox and hooks bind the agent's own tools:
 * `.claude/settings.json` and `settings.local.json` in its cwd and each parent up to the git
 * work tree's top (all of them, so a rule is never missed for the cwd it was launched from),
 * the account's `settings.json` in `CLAUDE_CONFIG_DIR`, and managed settings. A missing or
 * unparsable file contributes nothing.
 */
export async function readClaudeSettingsFiles(input: {
  cwd: string;
  configDir: string;
  managedPaths: readonly string[];
  homeDir: string;
}): Promise<ClaudeSettingsFile[]> {
  const candidates: Array<{ path: string; root: string | null }> = [];
  for (const root of projectRoots(input.cwd, input.homeDir)) {
    for (const name of ["settings.json", "settings.local.json"]) {
      candidates.push({ path: path.join(root, ".claude", name), root });
    }
  }
  candidates.push({ path: path.join(input.configDir, "settings.json"), root: null });
  for (const managed of input.managedPaths) candidates.push({ path: managed, root: null });
  const files: ClaudeSettingsFile[] = [];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await fs.readFile(candidate.path, "utf8");
    } catch {
      continue;
    }
    try {
      files.push({ ...candidate, settings: JSON.parse(text) as unknown });
    } catch {
      continue;
    }
  }
  return files;
}

/** The cwd, then each parent up to the first holding `.git`; never home or above it. */
function projectRoots(cwd: string, homeDir: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(cwd);
  const home = path.resolve(homeDir);
  for (let depth = 0; depth < 32; depth += 1) {
    if (current === home || isSameOrDescendantPath(current, home)) break;
    roots.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function pick(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
