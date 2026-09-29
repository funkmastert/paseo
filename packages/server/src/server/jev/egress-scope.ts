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
// macOS reaches `/Users` and every other firmlinked directory under the data volume too, and
// realpath keeps whichever spelling it is given. Folded, as darwin paths compare.
const DATA_VOLUME = "/system/volumes/data";
// A git hook or a parent git process sets these; inherited, they point every `-C` at one repository.
const INHERITED_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

export interface JevExclusionConfig {
  excludeCwds: string[];
  excludeRemotes: string[];
  excludeTextMarkers: string[];
}

/**
 * `signal` names the rule that matched (`cwd:2`, `remote:0`), never a path or text: the ledger keeps
 * it. `deadline` and `aborted` mean the check stopped before it could answer.
 */
export type JevScopeVerdict = { excluded: false } | { excluded: true; signal: string };

export interface JevScopeCheckOptions {
  /** Epoch ms. Git gets only the time left, none starts after it, and the check answers `deadline` by then. */
  deadlineAt?: number;
  /** Aborting answers `aborted` at once and kills a running git. */
  signal?: AbortSignal;
}

export interface JevGitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

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
  /** Argv, never a shell. Honours `timeoutMs` and `signal` by killing git. */
  runGit?: (args: string[], options: JevGitOptions) => Promise<JevGitResult>;
  /** Every cwd for these agents: own, ancestors, descendants (`resolveJevAgentCwds`). Throws or returns null for an unknown id. */
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
  /** `wonderlydotcom/` of `github.com/wonderlydotcom/`, matched on any host; null for a bare host. */
  ownerPath: string | null;
}

interface MarkerEntry {
  index: number;
  value: string;
}

interface CheckBudget {
  deadlineAt: number | undefined;
  signal: AbortSignal | undefined;
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

/** Thrown inside a check whose deadline passed or whose signal aborted; the verdict names which. */
class JevScopeCheckStopped extends Error {
  constructor(readonly reason: "deadline" | "aborted") {
    super(`jev scope check stopped: ${reason}`);
    this.name = "JevScopeCheckStopped";
  }
}

export class JevEgressScopeChecker {
  private readonly homeDir: string;
  private readonly foldsCase: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly runGit: (args: string[], options: JevGitOptions) => Promise<JevGitResult>;
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
  async check(
    scope: JevEgressScope,
    config: JevExclusionConfig,
    options: JevScopeCheckOptions = {},
  ): Promise<JevScopeVerdict> {
    const budget: CheckBudget = { deadlineAt: options.deadlineAt, signal: options.signal };
    try {
      return await this.withinBudget(this.checkScope(scope, config, budget), budget);
    } catch (error) {
      return error instanceof JevScopeCheckStopped ? excluded(error.reason) : excluded("error");
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

  /**
   * The check's answer, or `JevScopeCheckStopped` when the deadline or the signal comes first. The
   * work left behind starts no git (`git` checks the budget first) and its answer is dropped.
   */
  private async withinBudget<T>(work: Promise<T>, budget: CheckBudget): Promise<T> {
    const { deadlineAt, signal } = budget;
    if (deadlineAt === undefined && signal === undefined) return work;
    work.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      if (deadlineAt !== undefined) {
        const remaining = Math.max(0, deadlineAt - this.now());
        timer = setTimeout(() => reject(new JevScopeCheckStopped("deadline")), remaining);
      }
      if (signal) {
        onAbort = () => reject(new JevScopeCheckStopped("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The time the next git may take: the budget's remainder, at most the git timeout and at least
   * 1 ms (`execFile` reads a 0 timeout as none). Throws once the signal aborted or the deadline
   * passed, and for a deadline that is not a number.
   */
  private gitTimeoutMs(budget: CheckBudget): number {
    if (budget.signal?.aborted) throw new JevScopeCheckStopped("aborted");
    if (budget.deadlineAt === undefined) return GIT_TIMEOUT_MS;
    const remaining = budget.deadlineAt - this.now();
    if (!(remaining > 0)) throw new JevScopeCheckStopped("deadline");
    return Math.min(GIT_TIMEOUT_MS, Math.ceil(remaining));
  }

  /** Git bounded by the budget. None starts once the budget is spent. */
  private async git(args: string[], budget: CheckBudget): Promise<JevGitResult> {
    const timeoutMs = this.gitTimeoutMs(budget);
    const result = await this.runGit(args, { timeoutMs, signal: budget.signal });
    // Throws when the deadline or the signal cut git short, so the answer names why, not a git error.
    this.gitTimeoutMs(budget);
    return result;
  }

  private async checkScope(
    scope: JevEgressScope,
    config: JevExclusionConfig,
    budget: CheckBudget,
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
      .map((entry, index) => remoteEntry(entry, index))
      .filter((entry) => entry.value !== "");
    const markers = config.excludeTextMarkers
      .map((marker, index) => ({ index, value: foldText(marker) }))
      .filter((entry) => entry.value.trim() !== "");
    if (roots.length === 0 && remotes.length === 0 && markers.length === 0) return NOT_EXCLUDED;

    const directories = unique(await Promise.all(resolved.map(gitDirectoryOf)));
    const verdicts = await Promise.all(
      directories.map((directory) =>
        this.gitSignal(directory, { roots, remotes, markers }, budget),
      ),
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
    const folded = this.fold(p.replace(/\\/g, "/").replace(/\/$/, ""));
    if (this.platform !== "darwin") return folded;
    if (folded === DATA_VOLUME) return "";
    return folded.startsWith(`${DATA_VOLUME}/`) ? folded.slice(DATA_VOLUME.length) : folded;
  }

  private fold(value: string): string {
    return this.foldsCase ? value.toLowerCase() : value;
  }

  private async gitSignal(
    directory: string,
    rules: { roots: ExclusionRoot[]; remotes: RemoteEntry[]; markers: MarkerEntry[] },
    budget: CheckBudget,
  ): Promise<JevScopeVerdict | null> {
    const repository = await this.repositoryAt(directory, budget);
    if (repository === null) return null;
    // A worktree of a repository under a root shares its common directory, wherever it lives.
    const root = rules.roots.find((r) =>
      repository.commonDirForms.some((f) => this.isUnderRoot(f, r)),
    );
    if (root) return excluded(`common-dir:${root.index}`);
    const urls = await this.remoteUrlsAt(repository.topLevel, budget);
    return this.remoteSignal(urls, repository.topLevel, rules);
  }

  /**
   * An `excludeRemotes` entry on its own host, or its owner path on any host (an SSH host alias
   * such as `github-work` renames the host, never the owner); a local path remote under a root; or
   * any text marker in the URL.
   */
  private async remoteSignal(
    urls: string[],
    topLevel: string,
    rules: { roots: ExclusionRoot[]; remotes: RemoteEntry[]; markers: MarkerEntry[] },
  ): Promise<JevScopeVerdict | null> {
    const normalized = urls.map(normalizeRemoteUrl);
    const remote = rules.remotes.find((entry) =>
      normalized.some((url) => url.includes(entry.value) || matchesOwnerPath(url, entry)),
    );
    if (remote) return excluded(`remote:${remote.index}`);

    for (const url of urls) {
      const local = localRemotePath(url);
      if (local === null) continue;
      const absolute = this.absolutePath(local, topLevel);
      if (absolute === null) throw new Error("a local remote did not resolve");
      const { lexical, real } = await this.resolvePath(absolute);
      const root = rules.roots.find(
        (r) => this.isUnderRoot(lexical, r) || this.isUnderRoot(real, r),
      );
      if (root) return excluded(`remote-cwd:${root.index}`);
    }

    const forms = [...normalized, ...urls.map(foldText)];
    const marker = rules.markers.find((entry) => forms.some((form) => form.includes(entry.value)));
    return marker ? excluded(`remote-marker:${marker.index}`) : null;
  }

  private repositoryAt(directory: string, budget: CheckBudget): Promise<GitRepository | null> {
    return this.cached(this.repositories, directory, async () => {
      const result = await this.git(
        ["-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"],
        budget,
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

  /**
   * Every URL git would fetch from or push to, as git resolves it: `remote -v` applies `insteadOf`
   * and `pushInsteadOf` and lists push URLs. It reads config only and never touches the network.
   */
  private remoteUrlsAt(topLevel: string, budget: CheckBudget): Promise<string[]> {
    return this.cached(this.remoteUrls, topLevel, async () => {
      const result = await this.git(["-C", topLevel, "remote", "-v"], budget);
      if (!succeeded(result)) throw new Error("git remote failed");
      return parseRemoteList(result.stdout);
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

  /**
   * A root as text: its absolute path, each way a shell or redaction spells it under home, and its
   * name when that is distinctive (`git -C ../backend-net`). A `*` root by its prefix.
   */
  private rootTextForms(entry: string): string[] {
    const base = entry.replace(/[\\/]*\*?[\\/]*$/, "");
    if (base === "") return [];
    const absolute = this.expandHome(base);
    if (absolute === base && !path.isAbsolute(base)) {
      throw new Error("an excludeCwds entry is not absolute");
    }
    const name = rootName(entry);
    return unique([
      base,
      absolute,
      ...this.homeSpellings(absolute),
      ...(isDistinctiveName(name) ? [name] : []),
    ]);
  }

  /**
   * A path under home as text can spell it: `~/x` (redaction writes this), `~user/x`, `$HOME/x`,
   * `${HOME}/x`, `/Users/$USER/x`, and the cmd and PowerShell forms. Empty outside home.
   */
  private homeSpellings(absolute: string): string[] {
    const home = toForwardSlashes(this.homeDir).replace(/\/$/, "");
    const target = toForwardSlashes(absolute);
    if (!isSameOrDescendantPath(home.toLowerCase(), target.toLowerCase())) return [];
    const below = target.slice(home.length).replace(/^\/+/, "");
    const cut = home.lastIndexOf("/");
    const parent = home.slice(0, cut);
    const user = home.slice(cut + 1);
    const homes = [
      "~",
      `~${user}`,
      "$HOME",
      "${HOME}",
      `${parent}/$USER`,
      `${parent}/\${USER}`,
      "%USERPROFILE%",
      "$env:USERPROFILE",
      `${parent}/%USERNAME%`,
      `${parent}/$env:USERNAME`,
    ];
    return homes.map((spelling) => (below === "" ? spelling : `${spelling}/${below}`));
  }
}

/** `~/ts-monorepo*` is the parent `~` and every child whose name starts with `ts-monorepo`. */
function parseRootPattern(entry: string): RootPattern {
  const trimmed = entry.replace(/[\\/]+$/, "");
  if (!trimmed.endsWith("*")) return { base: entry, namePrefix: null };
  const namePrefix = path.basename(trimmed).slice(0, -1).normalize("NFC");
  return { base: path.dirname(trimmed), namePrefix };
}

/** The name a root is known by: `backend-net`, or `ts-monorepo` for `~/ts-monorepo*`. */
function rootName(entry: string): string {
  const { base, namePrefix } = parseRootPattern(entry);
  if (namePrefix !== null) return namePrefix;
  return toForwardSlashes(base).replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Whether a root's name is specific enough to search for on its own: at least 6 characters after
 * any leading dots, with a letter and a digit, `-`, `_` or `.`. `backend-net`, `ts-monorepo` and
 * `1rlfnz6g` are; a plain word (`code`, `app`, `work`, `Documents`, `.config`) would match ordinary
 * text, so only its path spellings count.
 */
function isDistinctiveName(name: string): boolean {
  const bare = name.replace(/^\.+/, "");
  return bare.length >= 6 && /\p{L}/u.test(bare) && /[0-9._-]/.test(bare);
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

function remoteEntry(entry: string, index: number): RemoteEntry {
  const value = normalizeRemoteEntry(entry);
  const slash = value.indexOf("/");
  const ownerPath = slash > 0 ? value.slice(slash + 1) : "";
  return { index, value, ownerPath: ownerPath === "" ? null : ownerPath };
}

/** `github-work/wonderlydotcom/mobile/` starts its path with `wonderlydotcom/`. */
function matchesOwnerPath(normalizedUrl: string, entry: RemoteEntry): boolean {
  if (entry.ownerPath === null) return false;
  return normalizedUrl.slice(normalizedUrl.indexOf("/") + 1).startsWith(entry.ownerPath);
}

/**
 * Each line of `git remote -v` is `<name>\t<url> (fetch)` or `(push)`; a remote with no URL prints
 * `<name>\t`. Any other line fails the check.
 */
function parseRemoteList(stdout: string): string[] {
  const urls: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "" || /^[^\t]+\t$/.test(line)) continue;
    const match = /^[^\t]+\t(.+) \((?:fetch|push)\)$/.exec(line);
    if (!match) throw new Error("git remote printed a line it could not read");
    urls.push(match[1]);
  }
  return unique(urls);
}

/**
 * The path of a remote that is a local repository, or null for a network URL. Git's rule: a
 * `scheme://` URL is remote unless it is `file://`; otherwise a colon before any slash is scp-style
 * SSH, except a drive letter.
 */
function localRemotePath(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    if (scheme[1].toLowerCase() !== "file") return null;
    const rest = url.slice(scheme[0].length);
    // `file:///x` is `/x`; `file://host/x` names a host first.
    return rest.startsWith("/") ? rest : rest.slice(Math.max(0, rest.indexOf("/")));
  }
  if (/^[a-z]:[\\/]/i.test(url)) return url;
  const colon = url.indexOf(":");
  const slash = url.search(/[\\/]/);
  return colon === -1 || (slash !== -1 && slash < colon) ? url : null;
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

function runGitProcess(args: string[], options: JevGitOptions): Promise<JevGitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        env: gitEnvironment(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // A timeout or abort kill, or a spawn failure, has no exit code; a git that ran and failed does.
        const timedOut = error.killed === true || options.signal?.aborted === true;
        const exitCode = typeof error.code === "number" && !timedOut ? error.code : null;
        resolve({ exitCode, stdout, stderr, timedOut });
      },
    );
  });
}
