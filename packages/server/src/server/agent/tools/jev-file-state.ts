import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";

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
 * them; the tools only decline to send them to a third party.
 */
const SECRET_NAME_RES = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|p8|jks|keystore|mobileprovision|tfvars)$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^credentials/i,
  /^\.credentials/i,
  /^hosts\.yml$/i,
  /^kubeconfig$/i,
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  /^local\.properties$/i,
  /^keystore\.properties$/i,
];

/** The same list as `:(exclude)` pathspecs for `git diff`, so a diff never carries these files. */
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
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
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
];

export function isSecretShapedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (SECRET_NAME_RES.some((re) => re.test(base))) return true;
  const parent = path.posix.basename(path.posix.dirname(normalized));
  return base.toLowerCase() === "config.json" && parent.toLowerCase() === ".docker";
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

/** Argv only, no shell, `LC_ALL=C` so "not a git repository" reads the same everywhere. */
export const runJevGit: JevGitRunner = (args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
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

function samePathOrBelow(base: string, candidate: string, platform: NodeJS.Platform): boolean {
  if (isSameOrDescendantPath(base, candidate)) return true;
  if (!foldsCase(platform)) return false;
  return isSameOrDescendantPath(base.toLowerCase(), candidate.toLowerCase());
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
    private readonly deniedRoots: string[],
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
    const root = path.parse(realCwd).root;
    if (
      realCwd === root ||
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
    const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: realCwd });
    const gitTop = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
    return {
      ok: true,
      scope: new JevFileScope(
        { cwd: options.cwd, homeDir, paseoHome: options.paseoHome, platform, denials, runGit },
        realCwd,
        gitTop,
        deniedRoots,
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
    if (stat.size === 0) return { path: shown, reason: "empty" };
    if (stat.size > JEV_FILE_MAX_BYTES) return { path: shown, reason: tooLarge(stat.size) };
    const relative = toPosix(path.relative(this.realCwd, realPath));
    return { path: relative || shown, absolutePath, realPath, dev: stat.dev, ino: stat.ino };
  }

  private inDeniedRoot(candidate: string): boolean {
    const { platform, homeDir } = this.options;
    if (this.deniedRoots.some((root) => samePathOrBelow(root, candidate, platform))) return true;
    // `~/.claude*`: every Claude config dir, one per account.
    return [homeDir, this.realHome].some((home) => {
      const relative = path.relative(home, candidate);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
      const first = relative.split(/[\\/]/)[0] ?? "";
      return (foldsCase(platform) ? first.toLowerCase() : first).startsWith(".claude");
    });
  }

  private deniedByAgent(candidate: string): boolean {
    const { denials, homeDir, platform } = this.options;
    const target = toPosix(candidate);
    return denials.patterns.some((raw) => {
      const pattern = toPosix(normalizeDenyPattern(raw, { cwd: this.cwd, homeDir }));
      if (!pattern) return false;
      const fold = foldsCase(platform);
      const a = fold ? target.toLowerCase() : target;
      const p = fold ? pattern.toLowerCase() : pattern;
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
    const byInput = new Map<string, string>();
    for (const candidate of candidates) byInput.set(candidate.realPath, candidate.realPath);
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
      const real = byInput.get(entry) ?? byInput.get(path.resolve(this.realCwd, entry));
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
const SECRET_NAME_REASON =
  "secret-shaped name; Read it if you need it, the JEV tools do not send it";

function tooLarge(bytes: number): string {
  return `over ${JEV_FILE_MAX_BYTES.toLocaleString("en-US")} bytes (${bytes.toLocaleString("en-US")}); use Read or grep`;
}

async function resolveDeniedRoots(homeDir: string, paseoHome: string): Promise<string[]> {
  const lexical = [
    paseoHome,
    ...[".config", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "Library"].map((name) =>
      path.join(homeDir, name),
    ),
  ];
  const roots = new Set<string>(lexical);
  for (const root of lexical) {
    const real = await realpathOrNull(root);
    if (real) roots.add(real);
  }
  return [...roots];
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

/**
 * Collects what the caller's configuration denies: `paseo.tools-denied`, and for Claude agents
 * `disallowedTools`, `settings.permissions.deny`, both `sandbox.filesystem.denyRead` lists, and
 * whether either sandbox is on.
 * Anything it cannot parse is ignored; the agent's own tools enforce those rules either way.
 */
export function readCallerDenials(input: {
  toolsDeniedLabel: string | undefined;
  providerOptions: unknown;
}): { read: JevReadDenials; bashDenied: boolean; sandboxed: boolean } {
  const toolRules = [
    ...(input.toolsDeniedLabel ?? "").split(","),
    ...stringArray(pick(input.providerOptions, ["disallowedTools"])),
    ...stringArray(pick(input.providerOptions, ["settings", "permissions", "deny"])),
  ]
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
  const patterns = [
    ...stringArray(pick(input.providerOptions, ["sandbox", "filesystem", "denyRead"])),
    ...stringArray(pick(input.providerOptions, ["settings", "sandbox", "filesystem", "denyRead"])),
  ];
  let all = false;
  let bashDenied = false;
  for (const rule of toolRules) {
    if (rule === "Read") all = true;
    const scoped = /^Read\((.*)\)$/s.exec(rule);
    if (scoped) {
      const spec = scoped[1]!.trim();
      if (spec === "" || spec === "*" || spec === "**" || spec === "//**") all = true;
      else patterns.push(spec);
    }
    // A command-scoped Bash rule is refused whole: code cannot tell which commands it covers.
    if (rule === "Bash" || rule.startsWith("Bash(")) bashDenied = true;
  }
  const sandboxed =
    pick(input.providerOptions, ["sandbox", "enabled"]) === true ||
    pick(input.providerOptions, ["settings", "sandbox", "enabled"]) === true;
  return { read: { all, patterns }, bashDenied, sandboxed };
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
