/**
 * The D7 exclusion (docs/jev.md, "The D7 exclusion"): whether a JEV call's scope or serialized
 * body touches company code. Fail closed: anything that cannot be checked answers excluded.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSameOrDescendantPath } from "../path-utils.js";
import type { JevEgressScope } from "./contract.js";

const GIT_TIMEOUT_MS = 2_000;
const ROOTS_TTL_MS = 5_000;
const GIT_TTL_MS = 5 * 60_000;
// A git hook or a parent git process sets these; inherited, they point every `-C` at one repository.
const INHERITED_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

export interface JevExclusionConfig {
  excludeCwds: string[];
  excludeRemotes: string[];
  excludeTextMarkers: string[];
}

/** `signal` names the rule that matched (`cwd:2`, `remote:0`), never a path or text: the ledger keeps it. */
export type JevScopeVerdict = { excluded: false } | { excluded: true; signal: string };

export interface JevGitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface EgressScopeDependencies {
  homeDir: string;
  /** Paths compare case-insensitively on darwin and win32. */
  platform: NodeJS.Platform;
  realpath?: (p: string) => Promise<string>;
  /** Argv, never a shell. */
  runGit?: (args: string[], options: { timeoutMs: number }) => Promise<JevGitResult>;
  /** Every cwd for these agents: own, ancestors, descendants (live or archived within 24 h). Throws or returns null for an unknown id. */
  resolveAgentCwds?: (agentIds: string[]) => Promise<string[] | null>;
  now?: () => number;
}

interface ResolvedPath {
  lexical: string;
  real: string;
  /** The realpath of the path, or of its deepest existing ancestor when the path does not exist. */
  existing: string;
  exists: boolean;
}

interface ExclusionRoot {
  index: number;
  /** Lexical and real forms. For a `*` root they are the parent's, and `namePrefix` applies below it. */
  forms: string[];
  namePrefix: string | null;
}

interface RootPattern {
  base: string;
  namePrefix: string | null;
}

interface RemoteEntry {
  index: number;
  value: string;
}

interface TextNeedle {
  value: string;
  signal: string;
}

interface GitRepository {
  topLevel: string;
  commonDirForms: string[];
}

interface Cached<T> {
  at: number;
  value: T;
}

interface CachedRoots extends Cached<ExclusionRoot[]> {
  key: string;
}

const NOT_EXCLUDED: JevScopeVerdict = { excluded: false };

function excluded(signal: string): JevScopeVerdict {
  return { excluded: true, signal };
}

export class JevEgressScopeChecker {
  private readonly homeDir: string;
  private readonly foldsCase: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly runGit: (
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<JevGitResult>;
  private readonly resolveAgentCwds: EgressScopeDependencies["resolveAgentCwds"];
  private readonly now: () => number;
  private roots: CachedRoots | null = null;
  private readonly repositories = new Map<string, Cached<GitRepository | null>>();
  private readonly remoteUrls = new Map<string, Cached<string[]>>();

  constructor(deps: EgressScopeDependencies) {
    this.homeDir = deps.homeDir;
    this.platform = deps.platform;
    this.foldsCase = deps.platform === "darwin" || deps.platform === "win32";
    // fs.promises.realpath already has realpath.native semantics.
    this.realpath = deps.realpath ?? ((p) => fs.realpath(p));
    this.runGit = deps.runGit ?? runGitProcess;
    this.resolveAgentCwds = deps.resolveAgentCwds;
    this.now = deps.now ?? Date.now;
  }

  /** Never throws. Any error inside answers `{ excluded: true, signal: "error" }`. */
  async check(scope: JevEgressScope, config: JevExclusionConfig): Promise<JevScopeVerdict> {
    try {
      return await this.checkScope(scope, config);
    } catch {
      return excluded("error");
    }
  }

  /**
   * The text scan on the exact serialized body that would be sent (state and questions, after
   * redaction). Never throws; an error answers excluded with signal `error`.
   */
  scanText(serializedBody: string, config: JevExclusionConfig): JevScopeVerdict {
    try {
      const text = foldText(serializedBody);
      // Windows paths arrive JSON-escaped (`C:\\Users\\…`); compare them with forward slashes too.
      const slashed = toForwardSlashes(text);
      const hit = this.textNeedles(config).find(
        (needle) => text.includes(needle.value) || slashed.includes(toForwardSlashes(needle.value)),
      );
      return hit ? excluded(hit.signal) : NOT_EXCLUDED;
    } catch {
      return excluded("error");
    }
  }

  private async checkScope(
    scope: JevEgressScope,
    config: JevExclusionConfig,
  ): Promise<JevScopeVerdict> {
    if (scope.missing) return excluded("missing");

    const requested = [...scope.cwds, ...(scope.files ?? [])];
    const scopePaths = requested.map((p) => this.absolutePath(p, scope.baseCwd));

    const agentIds = scope.agentIds ?? [];
    let agentCwds: string[] = [];
    if (agentIds.length > 0) {
      if (!this.resolveAgentCwds) return excluded("error");
      const resolvedCwds = await this.resolveAgentCwds(agentIds);
      if (resolvedCwds === null) return excluded("agent-unknown");
      agentCwds = resolvedCwds;
    }
    // An agent's recorded cwd never resolves against the scope's `baseCwd`.
    const agentPaths = agentCwds.map((cwd) => this.absolutePath(cwd, undefined));

    const absolutePaths = [...scopePaths, ...agentPaths];
    if (absolutePaths.includes(null)) return excluded("relative-no-base");
    const candidates = unique(absolutePaths.filter((p): p is string => p !== null));

    const roots = await this.resolveRoots(config.excludeCwds);
    const resolved = await Promise.all(candidates.map((candidate) => this.resolvePath(candidate)));
    for (const candidate of resolved) {
      const root = roots.find(
        (r) => this.isUnderRoot(candidate.lexical, r) || this.isUnderRoot(candidate.real, r),
      );
      if (root) return excluded(`cwd:${root.index}`);
    }

    const remotes = config.excludeRemotes
      .map((entry, index) => ({ index, value: normalizeRemoteEntry(entry) }))
      .filter((entry) => entry.value !== "");
    if (roots.length === 0 && remotes.length === 0) return NOT_EXCLUDED;

    const directories = unique(await Promise.all(resolved.map(gitDirectoryOf)));
    const verdicts = await Promise.all(
      directories.map((directory) => this.gitSignal(directory, roots, remotes)),
    );
    return verdicts.find((verdict) => verdict !== null) ?? NOT_EXCLUDED;
  }

  /** Null for a relative path with no absolute base: `process.cwd()` is the daemon's, never the subject's. */
  private absolutePath(p: string, base: string | undefined): string | null {
    const expanded = this.expandHome(p);
    if (path.isAbsolute(expanded)) return expanded;
    if (base === undefined) return null;
    const expandedBase = this.expandHome(base);
    if (!path.isAbsolute(expandedBase)) return null;
    // Joined, not resolved: realpath must apply `..` after a symlink, as the filesystem does.
    return `${expandedBase}${path.sep}${expanded}`;
  }

  private expandHome(p: string): string {
    if (p === "~") return this.homeDir;
    const isHomeRelative = p.startsWith("~/") || (this.platform === "win32" && p.startsWith("~\\"));
    return isHomeRelative ? `${this.homeDir}${path.sep}${p.slice(2)}` : p;
  }

  /** A path that does not exist yet takes its deepest existing ancestor's realpath plus the rest. */
  private async resolvePath(absolute: string): Promise<ResolvedPath> {
    const lexical = path.resolve(absolute).normalize("NFC");
    const missing: string[] = [];
    let ancestor = absolute;
    while (true) {
      try {
        const existing = (await this.realpath(ancestor)).normalize("NFC");
        const real = path.join(existing, ...missing).normalize("NFC");
        return { lexical, real, existing, exists: missing.length === 0 };
      } catch (error) {
        const parent = path.dirname(ancestor);
        if (!isNotFound(error) || parent === ancestor) throw error;
        missing.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }

  private async resolveRoots(entries: string[]): Promise<ExclusionRoot[]> {
    const key = JSON.stringify(entries);
    const now = this.now();
    if (this.roots && this.roots.key === key && now - this.roots.at < ROOTS_TTL_MS) {
      return this.roots.value;
    }
    const resolved = await Promise.all(
      entries.map((entry, index) => this.resolveRoot(entry, index)),
    );
    const value = resolved.filter((root): root is ExclusionRoot => root !== null);
    this.roots = { key, at: now, value };
    return value;
  }

  private async resolveRoot(entry: string, index: number): Promise<ExclusionRoot | null> {
    if (entry.trim() === "") return null;
    const { base, namePrefix } = parseRootPattern(entry);
    const absolute = this.expandHome(base);
    // Resolving it against the daemon's cwd would guess; fail closed instead.
    if (!path.isAbsolute(absolute)) throw new Error(`excludeCwds[${index}] is not absolute`);
    const { lexical, real } = await this.resolvePath(absolute);
    return { index, forms: [lexical, real], namePrefix };
  }

  private isUnderRoot(candidate: string, root: ExclusionRoot): boolean {
    const target = this.comparable(candidate);
    return root.forms.some((form) => {
      const base = this.comparable(form);
      if (!isSameOrDescendantPath(base, target)) return false;
      if (root.namePrefix === null) return true;
      const [name = ""] = target.slice(base.length).replace(/^\/+/, "").split("/");
      return name !== "" && name.startsWith(this.fold(root.namePrefix));
    });
  }

  /** The shape `isSameOrDescendantPath` compares, folded where the filesystem ignores case. */
  private comparable(p: string): string {
    return this.fold(p.replace(/\\/g, "/").replace(/\/$/, ""));
  }

  private fold(value: string): string {
    return this.foldsCase ? value.toLowerCase() : value;
  }

  private async gitSignal(
    directory: string,
    roots: ExclusionRoot[],
    remotes: RemoteEntry[],
  ): Promise<JevScopeVerdict | null> {
    const repository = await this.repositoryAt(directory);
    if (repository === null) return null;
    // A worktree of a repository under a root shares its common directory, wherever it lives.
    const root = roots.find((r) => repository.commonDirForms.some((f) => this.isUnderRoot(f, r)));
    if (root) return excluded(`common-dir:${root.index}`);
    if (remotes.length === 0) return null;
    const urls = await this.remoteUrlsAt(repository.topLevel);
    const remote = remotes.find((entry) => urls.some((url) => url.includes(entry.value)));
    return remote ? excluded(`remote:${remote.index}`) : null;
  }

  private repositoryAt(directory: string): Promise<GitRepository | null> {
    return this.cached(this.repositories, directory, async () => {
      const result = await this.runGit(
        ["-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (isNotARepository(result)) return null;
      if (!succeeded(result)) throw new Error("git rev-parse failed");
      const [topLevel, commonDir] = result.stdout.split(/\r?\n/);
      if (!topLevel || !commonDir) throw new Error("git rev-parse printed no top level");
      // Printed relative to `directory` when it is inside the main checkout.
      const common = await this.resolvePath(path.resolve(directory, commonDir));
      return { topLevel, commonDirForms: [common.lexical, common.real] };
    });
  }

  private remoteUrlsAt(topLevel: string): Promise<string[]> {
    return this.cached(this.remoteUrls, topLevel, async () => {
      const result = await this.runGit(
        ["-C", topLevel, "config", "--get-regexp", "^remote\\..*\\.url$"],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      const hasNoRemotes = result.exitCode === 1 && !result.timedOut && result.stdout.trim() === "";
      if (hasNoRemotes) return [];
      if (!succeeded(result)) throw new Error("git config failed");
      const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
      // Each line is `remote.<name>.url <url>`.
      return lines.map((line) => normalizeRemoteUrl(line.replace(/^\S+\s+/, "")));
    });
  }

  /** Failures are not cached: the next call retries, and is excluded again if git still fails. */
  private async cached<T>(
    cache: Map<string, Cached<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = cache.get(key);
    if (hit && this.now() - hit.at < GIT_TTL_MS) return hit.value;
    const value = await load();
    const now = this.now();
    for (const [staleKey, entry] of cache) {
      if (now - entry.at >= GIT_TTL_MS) cache.delete(staleKey);
    }
    cache.set(key, { at: now, value });
    return value;
  }

  private textNeedles(config: JevExclusionConfig): TextNeedle[] {
    const groups = [
      ...config.excludeTextMarkers.map((marker, index) => ({
        signal: `marker:${index}`,
        forms: [marker],
      })),
      ...config.excludeCwds.map((entry, index) => ({
        signal: `text-root:${index}`,
        forms: this.rootTextForms(entry),
      })),
      ...config.excludeRemotes.map((entry, index) => ({
        signal: `text-remote:${index}`,
        forms: remoteTextForms(entry),
      })),
    ];
    return groups.flatMap(({ signal, forms }) => {
      const values = forms.map(foldText).filter((value) => value.trim() !== "");
      return values.map((value) => ({ value, signal }));
    });
  }

  /** A root as text: its `~/…` form and its absolute form; a `*` root by its prefix. */
  private rootTextForms(entry: string): string[] {
    const base = entry.replace(/[\\/]*\*?[\\/]*$/, "");
    if (base === "") return [];
    const absolute = this.expandHome(base);
    if (absolute !== base) return [base, absolute];
    if (!path.isAbsolute(base)) throw new Error("an excludeCwds entry is not absolute");
    // Redaction rewrites the home prefix to `~`, so a root under home also appears in that form.
    if (!isSameOrDescendantPath(this.homeDir.toLowerCase(), base.toLowerCase())) return [base];
    const belowHome = base.slice(this.homeDir.length).replace(/^[\\/]+/, "");
    return [base, belowHome === "" ? "~" : `~/${belowHome}`];
  }
}

/** `~/ts-monorepo*` is the parent `~` and every child whose name starts with `ts-monorepo`. */
function parseRootPattern(entry: string): RootPattern {
  const trimmed = entry.replace(/[\\/]+$/, "");
  if (!trimmed.endsWith("*")) return { base: entry, namePrefix: null };
  const namePrefix = path.basename(trimmed).slice(0, -1).normalize("NFC");
  return { base: path.dirname(trimmed), namePrefix };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Where git runs for a candidate: the directory itself, a file's directory, or the deepest existing ancestor. */
async function gitDirectoryOf(candidate: ResolvedPath): Promise<string> {
  if (!candidate.exists) return candidate.existing;
  const stats = await fs.stat(candidate.existing);
  return stats.isDirectory() ? candidate.existing : path.dirname(candidate.existing);
}

function succeeded(result: JevGitResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function isNotARepository(result: JevGitResult): boolean {
  return result.exitCode === 128 && !result.timedOut && /not a git repository/i.test(result.stderr);
}

/** Lowercased, without scheme, userinfo or port; `git@host:org/repo` becomes `host/org/repo`. */
function normalizeRemoteLocation(value: string): string {
  const lowered = value.trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(lowered);
  if (scheme) {
    const rest = lowered.slice(scheme[0].length);
    const authorityEnd = rest.includes("/") ? rest.indexOf("/") : rest.length;
    const host = rest.slice(0, authorityEnd).replace(/^.*@/, "").replace(/:\d*$/, "");
    return host + rest.slice(authorityEnd);
  }
  const scpLike = /^(?:[^@/]*@)?([^:/]+):(.*)$/.exec(lowered);
  if (scpLike) return `${scpLike[1]}/${scpLike[2].replace(/^\/+/, "")}`;
  return lowered.replace(/^[^@/]*@/, "");
}

/**
 * Ends in `/` so an entry that ends in `/` matches whole segments: `github.com/wonderlydotcom/`
 * matches `github.com/wonderlydotcom/x` but not `github.com/wonderlydotcomx/y`.
 */
function normalizeRemoteUrl(url: string): string {
  return `${normalizeRemoteLocation(url)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")}/`;
}

function normalizeRemoteEntry(entry: string): string {
  return normalizeRemoteLocation(entry).replace(/\.git$/, "");
}

/** A remote entry as text: `host/org/`, and `host:org/` as it appears in `git@host:org/repo`. */
function remoteTextForms(entry: string): string[] {
  const normalized = normalizeRemoteEntry(entry);
  const slash = normalized.indexOf("/");
  if (slash <= 0) return [normalized];
  return [normalized, `${normalized.slice(0, slash)}:${normalized.slice(slash + 1)}`];
}

function foldText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\+/g, "/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // English messages: "not a git repository" is matched in stderr.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  return env;
}

function runGitProcess(args: string[], options: { timeoutMs: number }): Promise<JevGitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: options.timeoutMs, env: gitEnvironment(), windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // A timeout kill or a spawn failure has no exit code; a git that ran and failed does.
        const timedOut = error.killed === true;
        const exitCode = typeof error.code === "number" && !timedOut ? error.code : null;
        resolve({ exitCode, stdout, stderr, timedOut });
      },
    );
  });
}
