import { constants as fsConstants, promises as fsPromises, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import { JEV_TOOLS_LABEL } from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import {
  commandName,
  resolvePath,
  walkShellCommands,
  type ExpandedWord,
} from "../../agent/shell-commands.js";
import type { JevNotAskedReason, JevOutcome, JevSavingsSink, JevService } from "../contract.js";
import type { ResolvedJevConfig } from "../config.js";
import { runGitProcess, type JevGitOptions, type JevGitResult } from "../egress-scope.js";
import {
  decideLiveDeny,
  formatReadDenial,
  isLiveShareAgent,
  READ_CHECK_MAX_REGRETS_PER_HOUR,
  READ_CHECK_QUESTION_ID,
  readCheckAnswerOf,
  type ReadCheckAnswer,
} from "./decision.js";
import { isNamedRead } from "./named.js";
import { JEV_CHARS_PER_TOKEN } from "../savings-formulas.js";
import { isSecretShapedPath } from "../secret-paths.js";
import {
  isHomeOrAbove,
  isInside,
  isPersonalPath,
  shadowOnlyKind,
  type PersonalPathRules,
  type ShadowOnlyKind,
} from "./paths.js";
import {
  editedPath,
  rangeKey,
  READ_CHECK_EDIT_TOOLS,
  recognizeRead,
  type RecognizedFile,
  type RecognizedRead,
} from "./recognize.js";
import {
  applyFilters,
  buildReadCheckState,
  describeSize,
  estimateReadTokens,
  hasSubagentBriefContent,
  READ_CHECK_QUESTIONS,
  READ_TOOL_LINE_PREFIX_CHARS,
  readToolCharacters,
  recentLine,
  sliceRange,
  type SubagentBrief,
} from "./state.js";
import {
  ReadCheckValidation,
  type ReadCheckTimelineRow,
  type ReadCheckWindowClose,
} from "./validation.js";

/**
 * Feature 16, the file-read check (docs/jev.md, "Feature 16"). The Claude provider's hooks hand
 * every `Read`, Bash, and edit tool call here.
 *
 * Shadow, the default, never delays a read: `preToolUse` and `postToolUse` copy the hook input,
 * queue the work, and return in the same tick. The read is judged after its PostToolUse, from
 * what it actually loaded, so a `file_unchanged` dedup is never judged and the size floor is
 * exact. Live mode (D11) holds only a large read of an agent in the live share, for at most
 * `liveTimeoutMs`, and denies it once.
 */

export type ReadCheckConfig = ResolvedJevConfig["readCheck"];
export type { SubagentBrief } from "./state.js";

export interface FileReadHookEvent {
  /** The Paseo agent that owns the session; a subagent's calls carry its parent's id. */
  agentId: string;
  /** The session's cwd. A read outside it is never judged. */
  agentCwd: string;
  /** The SDK's hook input, as received. */
  input: unknown;
  /**
   * The subagent's own Agent/Task brief (R1), when the hook fired inside one: its tool call's
   * description and prompt, as the provider found them. Undefined outside a subagent; null when
   * the hook carries a subagent id this provider never declared, or a declared brief with no
   * content in either field (R4, `brief: missing` — see `hasSubagentBriefContent`).
   */
  subagentBrief?: SubagentBrief | null;
}

/** A live read held for its verdict. The callback denies with `denyReason`, or lets it run. */
export interface FileReadHold {
  verdict: Promise<{ denyReason: string } | null>;
  /** The callback never waits longer than this, whatever the promise does. */
  timeoutMs: number;
}

export interface FileReadObserver {
  /** PreToolUse for `Read`, `Bash` and the edit tools. Never throws; null lets the call run now. */
  preToolUse(event: FileReadHookEvent): FileReadHold | null;
  /** PostToolUse for `Read` and `Bash`. Never throws and never waits. */
  postToolUse(event: FileReadHookEvent): void;
  /** SubagentStop (KTD-2): drops that subagent's recent-calls ring. Never throws. */
  subagentEnd(subagentId: string): void;
}

/** The tools the observer's PreToolUse matchers cover. */
export const READ_CHECK_PRE_TOOLS = ["Read", "Bash", ...READ_CHECK_EDIT_TOOLS] as const;
/** The tools the observer's PostToolUse matchers cover. */
export const READ_CHECK_POST_TOOLS = ["Read", "Bash"] as const;

export interface ReadCheckAgentInfo {
  title: string | null;
  cwd: string;
  model: string | null;
  workspaceId: string | null;
  labels: Readonly<Record<string, string>>;
  /** The context window's used tokens at the last turn, when known. */
  contextTokens: number | null;
}

export interface ReadCheckAgentSource {
  agent(agentId: string): ReadCheckAgentInfo | null;
  /** The agent's first message: what it was created to do. */
  assignment(agentId: string): string | null;
  /** The newest rows, oldest first. */
  tail(agentId: string, limit: number): { epoch: string; rows: ReadCheckTimelineRow[] } | null;
  /** Rows after a cursor, oldest first. */
  after(
    agentId: string,
    cursor: { epoch: string; seq: number },
    limit: number,
  ): { epoch: string; rows: ReadCheckTimelineRow[] } | null;
}

export type ReadCheckStat = Pick<
  Stats,
  "nlink" | "size" | "isFile" | "isSymbolicLink" | "dev" | "ino" | "mtimeMs"
>;

/** The file the path checks saw: the read that follows must open this one, unchanged. */
export interface ReadCheckFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface ReadCheckFileSystem {
  realpath(filePath: string): Promise<string>;
  /**
   * At most `MAX_OBSERVER_FILE_BYTES` from the start of the regular file at `filePath`, opened
   * without following a symlink. Throws unless the file opened is `expected`, unchanged, with one
   * link, before and after the read.
   */
  readFile(filePath: string, expected: ReadCheckFileIdentity): Promise<Buffer>;
  /** Never opens the file. */
  stat(filePath: string): Promise<ReadCheckStat>;
  lstat(filePath: string): Promise<ReadCheckStat>;
  readlink(filePath: string): Promise<string>;
}

export interface ReadCheckObserverOptions {
  jev: Pick<JevService, "isActive" | "checkScope" | "decide" | "decisions">;
  savings: JevSavingsSink;
  /** `agents.jev.readCheck`, or null when the config cannot be read. Synchronous and cached. */
  readConfig: () => ReadCheckConfig | null;
  agents: ReadCheckAgentSource;
  homeDir: string;
  paseoHome: string;
  /** Default `os.tmpdir()`. The compound-engineering scratch D12 judges in shadow lives under it. */
  tmpDir?: string;
  logger: Logger;
  now?: () => number;
  fs?: ReadCheckFileSystem;
  /** How hook work is queued off the hook's tick. Default `setImmediate`. */
  defer?: (work: () => void) => void;
  /** The sweep's period. Default 60 s; 0 disables the timer (tests call `sweep`). */
  sweepIntervalMs?: number;
  /** Default `process.platform`: darwin and win32 compare paths case-insensitively. */
  platform?: NodeJS.Platform;
  /** Runs git for the ignored-file rule. Default: `git` as the D7 scope check runs it. */
  runGit?: (args: string[], options: JevGitOptions) => Promise<JevGitResult>;
}

const CALL_SITE_SHADOW = "read-check.shadow";
const CALL_SITE_LIVE = "read-check.live";
const REPEAT_MS = 30 * 60_000;
const PENDING_MS = 10 * 60_000;
const AGENT_IDLE_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const RECENT_TAIL_ROWS = 16;
const SCAN_ROWS = 200;
/** KTD-2: a subagent's own ring of recent Read, Bash and edit-tool calls. */
const SUBAGENT_RING_ROWS = 16;
/** A file larger than this is never read whole by the observer; its estimate is from its size. */
const MAX_OBSERVER_FILE_BYTES = 8 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const STOP_WAIT_MS = 1000;
/**
 * Reads judged at once, from the path checks to JEV's answer. A read past this is dropped as
 * `saturated`: a burst of large reads costs a few git runs, not one per read.
 */
const MAX_CONCURRENT_JUDGMENTS = 3;
/** Symlink hops followed when checking every name a path goes by; the kernel stops at 40. */
const MAX_SYMLINK_HOPS = 40;
/** Characters `Read` adds to each line: its number, a tab and the newline. */
const READ_TOOL_LINE_OVERHEAD = READ_TOOL_LINE_PREFIX_CHARS + 1;
/** How long a file copied or moved from a secret one is refused. */
const TAINT_MS = 24 * 60 * 60_000;
const GIT_TIMEOUT_MS = 2000;
/** Commands that write a copy of their sources: the last operand, or `-t`'s directory. */
const COPY_COMMANDS = new Set(["cp", "mv", "rsync", "ditto", "install", "ln", "gcp", "gmv"]);
/**
 * Dependency and build output: ignored by git, and the large reads the check exists to judge. An
 * ignored file anywhere else is a local file, which can hold anything, so it is never sent.
 */
const BUILD_DIRECTORIES = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "pods",
  "carthage",
  "deriveddata",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".gradle",
  ".build",
  ".dart_tool",
  "__pycache__",
  ".venv",
  "venv",
]);

interface HookFields {
  toolName: string;
  toolInput: unknown;
  toolUseId: string | null;
  cwd: string | null;
  subagentId: string | null;
  toolResponse: unknown;
}

function copyHookFields(input: unknown): HookFields | null {
  if (typeof input !== "object" || input === null) return null;
  const hook = input as Record<string, unknown>;
  const toolName = hook["tool_name"];
  if (typeof toolName !== "string") return null;
  return {
    toolName,
    toolInput: hook["tool_input"],
    toolUseId: typeof hook["tool_use_id"] === "string" ? hook["tool_use_id"] : null,
    cwd: typeof hook["cwd"] === "string" && hook["cwd"] ? hook["cwd"] : null,
    subagentId: typeof hook["agent_id"] === "string" ? hook["agent_id"] : null,
    toolResponse: hook["tool_response"],
  };
}

interface LiveSnapshot {
  enabled: boolean;
  live: boolean;
  liveShare: number;
}

interface PendingRead {
  agentId: string;
  at: number;
  /** Set when live mode judged this read at PreToolUse; Post settles its measurement. */
  live: Promise<string | null> | null;
  /** A retry of a path live mode denied: it goes through unchecked. */
  retryOfDeny: boolean;
}

interface AgentReadState {
  lastSeen: number;
  denied: Set<string>;
  edited: Set<string>;
  denies: number[];
  regrets: number[];
  /** `path|range` judged recently, to the time it was judged. */
  judged: Map<string, number>;
  assignment: string | null | undefined;
}

/** What one read loaded, as measured at PostToolUse. */
interface Measured {
  /** Characters in context per file: a multi-file Bash read is split evenly. */
  charactersPerFile: number;
  /** What `Read` loaded. Null for Bash: its output is never sent, the file is read from disk. */
  text: string | null;
  notText: boolean;
  dedup: boolean;
  /** Read's own line accounting, when it reported one. */
  lines: { first: number; count: number; total: number } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const NOTHING_MEASURED = { charactersPerFile: 0, text: null, dedup: false, lines: null } as const;

function measureReadTool(
  read: RecognizedRead,
  result: Record<string, unknown> | null,
): Measured | null {
  if (!result) return null;
  if (result["type"] === "file_unchanged")
    return { ...NOTHING_MEASURED, notText: false, dedup: true };
  const file = record(result["file"]);
  const content = file?.["content"];
  // An image, a PDF, a notebook: counted, never judged.
  if (result["type"] !== "text" || typeof content !== "string") {
    return { ...NOTHING_MEASURED, notText: true };
  }
  const count = typeof file?.["numLines"] === "number" ? file["numLines"] : 0;
  return {
    charactersPerFile: readToolCharacters(content),
    text: content,
    notText: read.notText || content.includes("\u0000"),
    dedup: false,
    lines: {
      first: typeof file?.["startLine"] === "number" ? file["startLine"] : 1,
      count,
      total: typeof file?.["totalLines"] === "number" ? file["totalLines"] : count,
    },
  };
}

function measureBash(read: RecognizedRead, response: unknown): Measured | null {
  const result = record(response);
  let stdout: string;
  let stderr = "";
  if (typeof response === "string") {
    stdout = response;
  } else if (result && result["isImage"] !== true) {
    stdout = typeof result["stdout"] === "string" ? result["stdout"] : "";
    stderr = typeof result["stderr"] === "string" ? result["stderr"] : "";
  } else {
    return result ? { ...NOTHING_MEASURED, notText: true } : null;
  }
  return {
    charactersPerFile: (stdout.length + stderr.length) / read.files.length,
    text: null,
    notText: stdout.slice(0, BINARY_PROBE_BYTES).includes("\u0000"),
    dedup: false,
    lines: null,
  };
}

/** What one read loaded, from its PostToolUse `tool_response`. */
function measure(read: RecognizedRead, response: unknown): Measured | null {
  return read.tool === "Read"
    ? measureReadTool(read, record(response))
    : measureBash(read, response);
}

/** KTD-2: one read, rendered the same shape `recentLine` already knows how to show. */
function readRingItem(
  hook: HookFields,
  read: RecognizedRead,
  file: RecognizedFile,
): AgentTimelineItem {
  const callId = hook.toolUseId ?? "";
  if (read.tool === "Bash") {
    const command = record(hook.toolInput)?.["command"];
    return {
      type: "tool_call",
      callId,
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command: typeof command === "string" ? command : "" },
    };
  }
  return {
    type: "tool_call",
    callId,
    name: "Read",
    status: "completed",
    error: null,
    detail: { type: "read", filePath: file.path },
  };
}

/** A tool call appears once per state it went through; `recent` keeps only its newest row. */
function latestRowPerCall(rows: readonly ReadCheckTimelineRow[]): ReadCheckTimelineRow[] {
  const last = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.item.type === "tool_call") last.set(row.item.callId, index);
  });
  return rows.filter(
    (row, index) => row.item.type !== "tool_call" || last.get(row.item.callId) === index,
  );
}

/** R3: the newest `user_message` in the tail — the current turn's latest prompt, when there is one. */
function latestUserPromptOf(recent: readonly AgentTimelineItem[]): string | null {
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]!;
    if (item.type === "user_message" && item.text.trim()) return item.text;
  }
  return null;
}

function hasTextBody(buffer: Buffer): boolean {
  return !buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

function displayPathOf(realPath: string, agentCwd: string): string {
  const relative = path.relative(agentCwd, realPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : realPath;
}

/** A call that sent nothing is a daily counter, never a record. */
function notAskedReasonFor(
  outcome: Extract<JevOutcome, { kind: "unavailable" }>,
): JevNotAskedReason {
  if (outcome.reason === "excluded") return "excluded";
  return outcome.reason === "saturated" ? "saturated" : "inactive";
}

type RangeText = ReturnType<typeof sliceRange>;

/** A command's file operands, resolved, and the directory a `-t` option names. */
function commandOperands(
  words: readonly ExpandedWord[],
  cwd: string | null,
): { operands: string[]; target: string | null } {
  const operands: string[] = [];
  let target: string | null = null;
  let optionsEnded = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!optionsEnded && word.text === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.text.startsWith("-") && word.text.length > 1) {
      if (word.text === "-t" || word.text === "--target-directory") {
        const next = words[index + 1];
        index += 1;
        target = next?.resolved ? resolvePath(cwd, next.text) : null;
      } else if (word.text.startsWith("--target-directory=") && word.resolved) {
        target = resolvePath(cwd, word.text.slice("--target-directory=".length));
      }
      continue;
    }
    const resolved = word.resolved ? resolvePath(cwd, word.text) : null;
    if (resolved !== null) operands.push(resolved);
  }
  return { operands, target };
}

type SliceResult = ({ kind: "text" } & RangeText) | { kind: "not-text" | "changed" };

/**
 * Whether a `Read`'s text is what is on disk. The tool may drop a final newline or turn CRLF into
 * LF; nothing else may differ.
 */
function sameText(onDisk: string, loaded: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalize(onDisk) === normalize(loaded);
}

interface ShadowReadInput {
  event: FileReadHookEvent;
  /** When the read's result arrived. */
  at: number;
  hook: HookFields;
  read: RecognizedRead;
  file: RecognizedFile;
  realPath: string;
  measured: Measured | null;
  contextTokens: number | null;
  config: ReadCheckConfig | null;
  state: AgentReadState;
  /** The validation signal mark just after this read was noted: later uses are replayed. */
  signalMark: number;
}

interface LiveReadInput {
  event: FileReadHookEvent;
  hook: HookFields;
  read: RecognizedRead;
  file: RecognizedFile;
  config: ReadCheckConfig;
  signalMark: number;
  /** False once the read was let through: a deny then is never given. */
  settleVerdict: (value: { denyReason: string } | null) => boolean;
}

/** One JEV call that came back with something worth a record. */
interface Asked {
  callId: string;
  kind: "answered" | "shadow" | "failed";
  answer: ReadCheckAnswer;
  agent: ReadCheckAgentInfo | null;
  displayPath: string;
  around: {
    recent: AgentTimelineItem[];
    cursor: { epoch: string; seq: number } | null;
    turnId: string | null;
  };
}

function identityOf(stat: ReadCheckStat): ReadCheckFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function isSameFile(stat: ReadCheckStat, expected: ReadCheckFileIdentity): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeMs === expected.mtimeMs
  );
}

/** Windows has no `O_NOFOLLOW`: there the path is lstat'ed first and the handle checked after. */
const OPEN_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export const defaultReadCheckFs: ReadCheckFileSystem = {
  realpath: (filePath) => fsPromises.realpath(filePath),
  stat: (filePath) => fsPromises.stat(filePath),
  lstat: (filePath) => fsPromises.lstat(filePath),
  readlink: (filePath) => fsPromises.readlink(filePath),
  readFile: async (filePath, expected) => {
    if (fsConstants.O_NOFOLLOW === undefined) {
      const link = await fsPromises.lstat(filePath);
      if (link.isSymbolicLink()) throw new Error("a symlink");
    }
    const handle = await fsPromises.open(filePath, OPEN_NO_FOLLOW);
    try {
      if (!isSameFile(await handle.stat(), expected)) throw new Error("the file changed");
      const length = Math.min(expected.size, MAX_OBSERVER_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      // A write during the read changes the size or the modification time.
      if (bytesRead !== length || !isSameFile(await handle.stat(), expected)) {
        throw new Error("the file changed");
      }
      return buffer;
    } finally {
      await handle.close();
    }
  },
};

interface Refused {
  eligible: false;
  reason: JevNotAskedReason;
}

/**
 * What the shadow track may send. `shadowOnly` names the D12 subtree a read came from, which the
 * record carries so the dashboard can tell those judgments apart; null is an ordinary read.
 */
type ShadowEligibility =
  | { eligible: true; identity: ReadCheckFileIdentity; shadowOnly: ShadowOnlyKind | null }
  | Refused;

/**
 * What the live track may send. It has no `shadowOnly` member on purpose: the D12 subtrees are
 * admitted by `classify` only under `track: "shadow"`, so no value of this type can describe one
 * of those reads and no live code path can reach a deny for them (docs/jev.md, D12). Widening this
 * type is the only way to break that, which is what makes the property structural.
 */
type LiveEligibility = { eligible: true; identity: ReadCheckFileIdentity } | Refused;

interface EligibilityInput {
  agentId: string;
  agentCwd: string;
  namedPath: string;
  realPath: string;
}

export class ReadCheckObserver implements FileReadObserver {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fs: ReadCheckFileSystem;
  private readonly defer: (work: () => void) => void;
  private readonly validation: ReadCheckValidation;
  private readonly agents = new Map<string, AgentReadState>();
  private readonly pending = new Map<string, PendingRead>();
  /**
   * KTD-2: per-subagent-id ring of its own recent Read, Bash and edit-tool calls. `lastSeen`
   * lets `sweep` evict a ring whose subagent never fires `SubagentStop` — crashed, killed, or
   * whose parent disconnected — the same `AGENT_IDLE_MS` bound the `agents` map uses below.
   */
  private readonly subagentRings = new Map<
    string,
    { items: AgentTimelineItem[]; lastSeen: number }
  >();
  private readonly personal: PersonalPathRules;
  private readonly runGit: (args: string[], options: JevGitOptions) => Promise<JevGitResult>;
  /** Paths written by a copy or move of a secret file, folded, to when they stop being refused. */
  private readonly tainted = new Map<string, number>();
  private realRootsAdded = false;
  private judging = 0;
  private liveSnapshot: LiveSnapshot = { enabled: false, live: false, liveShare: 0 };
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly options: ReadCheckObserverOptions) {
    this.logger = options.logger.child({ module: "jev-read-check" });
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? defaultReadCheckFs;
    this.defer = options.defer ?? ((work) => setImmediate(work));
    this.runGit = options.runGit ?? runGitProcess;
    const platform = options.platform ?? process.platform;
    this.personal = {
      homeDirs: [options.homeDir],
      paseoHomes: [options.paseoHome],
      // `/tmp` is a symlink to `/private/tmp` on darwin, so a scratch file arrives spelled either
      // way depending on whether it came through `realpath`.
      tmpDirs: [
        ...new Set([
          options.tmpDir ?? os.tmpdir(),
          ...(platform === "darwin" ? ["/tmp", "/private/tmp"] : []),
        ]),
      ],
      platform,
    };
    this.validation = new ReadCheckValidation({
      now: this.now,
      onClose: (close) => this.onWindowClose(close),
    });
    this.refreshLiveSnapshot();
    const period = options.sweepIntervalMs ?? 60_000;
    if (period > 0) {
      this.sweepTimer = setInterval(() => this.track(this.sweep()), period);
      this.sweepTimer.unref?.();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Hook entry points. Synchronous and cheap: copy, queue, return.
  // -------------------------------------------------------------------------------------------

  preToolUse(event: FileReadHookEvent): FileReadHold | null {
    try {
      const hook = copyHookFields(event.input);
      if (!hook) return null;
      if ((READ_CHECK_EDIT_TOOLS as readonly string[]).includes(hook.toolName)) {
        const at = this.now();
        this.defer(() => this.track(this.onEdit(event, hook, at)));
        return null;
      }
      if (hook.toolName !== "Read" && hook.toolName !== "Bash") return null;
      // Shadow, the default: one field read and the call runs. The read is judged after it ran.
      const live = this.liveSnapshot;
      if (!live.enabled || !live.live || !isLiveShareAgent(event.agentId, live.liveShare)) {
        return null;
      }
      return this.maybeHold(event, hook, this.now());
    } catch (error) {
      this.logger.debug({ err: error }, "read check: pre hook failed; the call runs");
      return null;
    }
  }

  postToolUse(event: FileReadHookEvent): void {
    try {
      const hook = copyHookFields(event.input);
      if (!hook || (hook.toolName !== "Read" && hook.toolName !== "Bash")) return;
      const at = this.now();
      this.defer(() => this.track(this.onPostRead(event, hook, at)));
    } catch (error) {
      this.logger.debug({ err: error }, "read check: post hook failed");
    }
  }

  /** Expires pending reads and windows, and scans open windows' later rows. Also on a timer. */
  async sweep(): Promise<void> {
    try {
      const now = this.now();
      this.refreshLiveSnapshot();
      for (const [id, pending] of this.pending) {
        if (now - pending.at >= PENDING_MS) this.pending.delete(id);
      }
      for (const [agentId, state] of this.agents) {
        for (const [key, at] of state.judged) {
          if (now - at >= REPEAT_MS) state.judged.delete(key);
        }
        state.denies = state.denies.filter((at) => now - at < HOUR_MS);
        state.regrets = state.regrets.filter((at) => now - at < HOUR_MS);
        if (now - state.lastSeen >= AGENT_IDLE_MS && state.denied.size === 0) {
          this.agents.delete(agentId);
        }
      }
      for (const [key, until] of this.tainted) {
        if (now >= until) this.tainted.delete(key);
      }
      // A subagent that crashes, is killed, or whose parent disconnects never fires
      // `SubagentStop`: the same idle bound the `agents` map uses above reclaims its ring.
      for (const [subagentId, ring] of this.subagentRings) {
        if (now - ring.lastSeen >= AGENT_IDLE_MS) this.subagentRings.delete(subagentId);
      }
      for (const agentId of this.validation.agentsWithOpenWindows()) this.scanAgent(agentId);
      this.validation.expire(now);
    } catch (error) {
      this.logger.debug({ err: error }, "read check: sweep failed");
    }
  }

  /**
   * Stops the sweep and gives queued work a moment to land its records. A judgment still waiting
   * on JEV past that is dropped: shutdown never waits out a JEV deadline.
   */
  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** Test seam: resolves once every queued piece of work has finished. */
  async idle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.inFlight.size === 0) return;
      await Promise.allSettled(this.inFlight);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Shared state
  // -------------------------------------------------------------------------------------------

  private track<T>(promise: Promise<T>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
  }

  private refreshLiveSnapshot(): ReadCheckConfig | null {
    let config: ReadCheckConfig | null = null;
    try {
      config = this.options.readConfig();
    } catch {
      config = null;
    }
    this.liveSnapshot = config
      ? { enabled: config.enabled, live: !config.shadow, liveShare: config.liveShare }
      : { enabled: false, live: false, liveShare: 0 };
    return config;
  }

  private stateFor(agentId: string): AgentReadState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = {
        lastSeen: this.now(),
        denied: new Set(),
        edited: new Set(),
        denies: [],
        regrets: [],
        judged: new Map(),
        assignment: undefined,
      };
      this.agents.set(agentId, state);
    }
    state.lastSeen = this.now();
    return state;
  }

  /**
   * R4: true only for a subagent read whose own brief is absent or content-free — the condition
   * live mode's never-deny guarantee depends on (finding #5: a declared-but-empty brief is not
   * "found" just because the container exists). One check, shared by the shadow and live
   * judgment paths (finding #9).
   */
  private subagentBriefMissing(
    subagentId: string | null,
    brief: SubagentBrief | null | undefined,
  ): boolean {
    return subagentId !== null && !hasSubagentBriefContent(brief);
  }

  /** SubagentStop (KTD-2): the ring is dropped when the subagent ends. */
  subagentEnd(subagentId: string): void {
    try {
      this.subagentRings.delete(subagentId);
    } catch (error) {
      this.logger.debug({ err: error }, "read check: subagent end failed");
    }
  }

  /** KTD-2: appends one rendered-ready call to `subagentId`'s own ring, capped at 16. */
  private pushRing(subagentId: string | null, item: AgentTimelineItem): void {
    if (!subagentId) return;
    const items = this.subagentRings.get(subagentId)?.items ?? [];
    items.push(item);
    if (items.length > SUBAGENT_RING_ROWS) items.shift();
    this.subagentRings.set(subagentId, { items, lastSeen: this.now() });
  }

  private assignmentOf(agentId: string, state: AgentReadState): string | null {
    if (state.assignment === undefined) {
      try {
        state.assignment = this.options.agents.assignment(agentId);
      } catch {
        state.assignment = null;
      }
    }
    return state.assignment ?? null;
  }

  private async realpathOf(filePath: string): Promise<string> {
    try {
      return await this.fs.realpath(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }

  private countNotAsked(reason: JevNotAskedReason): void {
    try {
      this.options.savings.countNotAsked("readCheck", reason);
    } catch {
      // Never reaches the agent.
    }
  }

  private notePending(
    event: FileReadHookEvent,
    hook: HookFields,
    at: number,
    live: Promise<string | null> | null,
    retryOfDeny = false,
  ): void {
    if (!hook.toolUseId) return;
    this.pending.set(hook.toolUseId, { agentId: event.agentId, at, live, retryOfDeny });
  }

  private async onEdit(event: FileReadHookEvent, hook: HookFields, at: number): Promise<void> {
    const target = editedPath({
      toolName: hook.toolName,
      toolInput: hook.toolInput,
      cwd: hook.cwd ?? event.agentCwd,
      home: this.options.homeDir,
    });
    if (!target) return;
    const real = await this.realpathOf(target);
    this.stateFor(event.agentId).edited.add(real);
    this.validation.noteEdit(event.agentId, real, at);
    if (!this.isRefusedForRing(target, real)) {
      this.pushRing(hook.subagentId, {
        type: "tool_call",
        callId: hook.toolUseId ?? "",
        name: hook.toolName,
        status: "completed",
        error: null,
        detail: { type: hook.toolName === "Write" ? "write" : "edit", filePath: target },
      });
    }
  }

  /**
   * Finding #4: a secret-shaped or personal name must never reach a subagent's ring, even though
   * the ring's own push is not gated on the full `classify()` eligibility check (which runs git
   * and the file system for every judged read, too costly to run for every observed call). This
   * is the same name test `classify` runs first, before any of that work, on both the path as
   * named and its real path.
   */
  private isRefusedForRing(namedPath: string, realPath: string): boolean {
    return [namedPath, realPath].some(
      (name) => isSecretShapedPath(name) || isPersonalPath(name, this.personal),
    );
  }

  private onWindowClose(close: ReadCheckWindowClose): void {
    if (close.validation.outcome === "regret") {
      this.stateFor(close.agentId).regrets.push(this.now());
    }
    try {
      this.options.savings.validate(close.savingsId, close.validation);
    } catch {
      // Never reaches the agent.
    }
  }

  private scanAgent(agentId: string): void {
    for (const window of this.validation.openFor(agentId)) {
      try {
        const page = window.after
          ? this.options.agents.after(agentId, window.after, SCAN_ROWS)
          : this.options.agents.tail(agentId, SCAN_ROWS);
        if (page) this.validation.scan(window.savingsId, page.epoch, page.rows);
      } catch {
        // An agent no longer loaded keeps its window until it expires as held.
      }
    }
  }

  /** The timeline around the read: `recent` without the read's own call, and its cursor. */
  private timelineAround(
    agentId: string,
    toolUseId: string | null,
  ): {
    recent: AgentTimelineItem[];
    cursor: { epoch: string; seq: number } | null;
    turnId: string | null;
  } {
    let page: { epoch: string; rows: ReadCheckTimelineRow[] } | null = null;
    try {
      page = this.options.agents.tail(agentId, RECENT_TAIL_ROWS);
    } catch {
      page = null;
    }
    if (!page) return { recent: [], cursor: null, turnId: null };
    const isOwn = (row: ReadCheckTimelineRow) =>
      toolUseId !== null && row.item.type === "tool_call" && row.item.callId === toolUseId;
    const first = page.rows.findIndex(isOwn);
    const before = first >= 0 ? page.rows.slice(0, first) : page.rows;
    // The read's own newest row when it is there, else the newest: later rows are scanned from it.
    const own = page.rows.filter(isOwn);
    const anchor = own[own.length - 1] ?? page.rows[page.rows.length - 1];
    return {
      recent: latestRowPerCall(before).map((row) => row.item),
      cursor: anchor ? { epoch: page.epoch, seq: anchor.seq } : null,
      turnId: anchor?.turnId ?? null,
    };
  }

  /**
   * R3: the search call (`rg`, `grep`, `find`, a Glob) whose matched files named this read's
   * path, from the read's own turn — even past the ordinary 16-row tail `timelineAround` keeps.
   * Null when none did, or there is no current turn to search.
   */
  private findPinnedSearchLine(
    agentId: string,
    toolUseId: string | null,
    turnId: string | null,
    displayPath: string,
    realPath: string,
  ): string | null {
    if (!turnId) return null;
    let page: { epoch: string; rows: ReadCheckTimelineRow[] } | null = null;
    try {
      page = this.options.agents.tail(agentId, SCAN_ROWS);
    } catch {
      return null;
    }
    if (!page) return null;
    const isOwn = (row: ReadCheckTimelineRow) =>
      toolUseId !== null && row.item.type === "tool_call" && row.item.callId === toolUseId;
    const first = page.rows.findIndex(isOwn);
    const before = first >= 0 ? page.rows.slice(0, first) : page.rows;
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const row = before[index]!;
      if (row.turnId !== turnId) continue;
      const item = row.item;
      if (item.type !== "tool_call" || item.detail.type !== "search") continue;
      const files = item.detail.filePaths ?? [];
      if (files.includes(displayPath) || files.includes(realPath)) return recentLine(item);
    }
    return null;
  }

  /**
   * Rules 3 and 4 of "When JEV is asked". Default deny: a file is sent only when it is inside the
   * agent's cwd and inside a git work tree below the home directory, and no name it goes by (as
   * named, each symlink hop, its real path) is secret-shaped or personal. A hard link could be
   * any file under another name, so one is never sent. Then the D7 scope check. Nothing here
   * opens the file.
   */
  private async classify(
    input: EligibilityInput & { track: "shadow" | "live" },
  ): Promise<ShadowEligibility> {
    const refuse = (reason: JevNotAskedReason): Refused => ({ eligible: false, reason });
    // Taken before any name is checked: the file read later must be this one (`isSameFile`), so
    // a swap during the checks, or during git, sends nothing.
    const stat = await this.fs.lstat(input.realPath).catch(() => null);
    await this.addRealRoots();
    // A D12 subtree, for the shadow track only. The name rules below still run on every name the
    // file goes by, so a link out of `plugins/cache` into anything private is still refused.
    const shadowOnly =
      input.track === "shadow" ? shadowOnlyKind(input.realPath, this.personal) : null;
    if (shadowOnly === null) {
      const realCwd = await this.realpathOf(input.agentCwd);
      if (!isInside(input.realPath, realCwd, this.personal.platform)) return refuse("outside-cwd");
    }
    const names = [...(await this.symlinkChain(input.namedPath)), input.realPath];
    if (
      names.some(
        (name) =>
          isSecretShapedPath(name) || isPersonalPath(name, this.personal) || this.isTainted(name),
      )
    ) {
      return refuse("secret-path");
    }
    if (stat?.isSymbolicLink()) return refuse("changed");
    if (!stat?.isFile()) return refuse("not-text");
    if (stat.nlink > 1) return refuse("secret-path");
    // A D12 subtree is outside every repository by nature, which is why it needed a decision.
    if (shadowOnly === null) {
      const workTree = await this.workTreeOf(input.realPath);
      if (workTree === null || isHomeOrAbove(workTree, this.personal)) {
        return refuse("outside-repo");
      }
      if (await this.isLocalOnly(workTree, input.realPath)) return refuse("secret-path");
    }
    const scope = await this.options.jev
      .checkScope({
        cwds: [input.agentCwd],
        files: [input.realPath],
        baseCwd: input.agentCwd,
        agentIds: [input.agentId],
      })
      .catch(() => "excluded" as const);
    if (scope !== "ok") return refuse("excluded");
    return { eligible: true, identity: identityOf(stat), shadowOnly };
  }

  /** The shadow track's answer, which may admit a D12 subtree. */
  private eligibilityForShadow(input: EligibilityInput): Promise<ShadowEligibility> {
    return this.classify({ ...input, track: "shadow" });
  }

  /**
   * The live track's answer. `track: "live"` leaves `shadowOnly` null inside `classify`, so a D12
   * read takes the ordinary rules and is refused `outside-cwd` here — the live track never sees
   * one, and the read is judged after it ran by the shadow track like any other agent's.
   */
  private async eligibilityForLive(input: EligibilityInput): Promise<LiveEligibility> {
    const answer = await this.classify({ ...input, track: "live" });
    return answer.eligible ? { eligible: true, identity: answer.identity } : answer;
  }

  /**
   * A file git ignores outside dependency and build output: `.dev.vars`, `appsettings.Local.json`,
   * a key someone saved in the project. Any answer but git's "not ignored" refuses it.
   */
  private async isLocalOnly(workTree: string, realPath: string): Promise<boolean> {
    const relative = path.relative(workTree, realPath);
    const directories = relative.split(/[\\/]/).slice(0, -1);
    if (directories.some((name) => BUILD_DIRECTORIES.has(name.toLowerCase()))) return false;
    try {
      const result = await this.runGit(["-C", workTree, "check-ignore", "-q", "--", relative], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      return result.exitCode !== 1;
    } catch {
      return true;
    }
  }

  private taintKey(filePath: string): string {
    const resolved = path.resolve(filePath).normalize("NFC");
    const platform = this.personal.platform;
    return platform === "darwin" || platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private isTainted(filePath: string): boolean {
    const until = this.tainted.get(this.taintKey(filePath));
    return until !== undefined && this.now() < until;
  }

  private taint(filePaths: Iterable<string>, at: number): void {
    for (const filePath of filePaths) this.tainted.set(this.taintKey(filePath), at + TAINT_MS);
  }

  private isSecretSource(filePath: string): boolean {
    return (
      isSecretShapedPath(filePath) ||
      isPersonalPath(filePath, this.personal) ||
      this.isTainted(filePath)
    );
  }

  /**
   * A Bash line that copies, moves or links a secret file (`cp .env notes.txt`, `mv`, `rsync`,
   * `ditto`, `install`, `ln`), or writes one through `tee` or `>`: every file the line writes is
   * refused for 24 hours, since its name no longer says what it holds. The lexical paths are
   * taken before anything awaits, so a read queued after this line already sees them.
   */
  private async noteCopies(hook: HookFields, cwd: string, at: number): Promise<void> {
    const command = record(hook.toolInput)?.["command"];
    if (typeof command !== "string") return;
    const sources: string[] = [];
    const written: string[] = [];
    walkShellCommands(
      command,
      { cwd, home: this.options.homeDir },
      {
        command(args, context) {
          const name = commandName(args[0]!.text);
          const { operands, target } = commandOperands(args.slice(1), context.cwd);
          sources.push(...operands);
          if (name === "tee") written.push(...operands);
          if (COPY_COMMANDS.has(name)) {
            const into = target ?? (operands.length >= 2 ? operands[operands.length - 1]! : null);
            const from = target ? operands : operands.slice(0, -1);
            if (into !== null) {
              written.push(into, ...from.map((source) => path.join(into, path.basename(source))));
            }
          }
          return false;
        },
        outputRedirect(target, context) {
          const resolved = target.resolved ? resolvePath(context.cwd, target.text) : null;
          if (resolved !== null && resolved !== "/dev/null") written.push(resolved);
          return false;
        },
      },
    );
    if (written.length === 0 || sources.length === 0) return;
    if (sources.some((source) => this.isSecretSource(source))) {
      this.taint(written, at);
    } else {
      // A symlink onto a secret file: `cp link notes.txt`.
      const real = await Promise.all(sources.map((source) => this.realpathOf(source)));
      if (!real.some((source) => this.isSecretSource(source))) return;
      this.taint(written, at);
    }
    const realWritten = await Promise.all(written.map((file) => this.realpathOf(file)));
    this.taint(realWritten, at);
  }

  /**
   * The home directory, Paseo's home and the temporary directory as realpath spells them, checked
   * as well as the configured ones: a file always arrives as its real path, so a root compared in
   * one spelling stops refusing the state it is there to protect, or stops recognising the subtree
   * it is there to judge.
   */
  private async addRealRoots(): Promise<void> {
    if (this.realRootsAdded) return;
    this.realRootsAdded = true;
    const realHome = await this.realpathOf(this.options.homeDir);
    if (!this.personal.homeDirs.includes(realHome)) this.personal.homeDirs.push(realHome);
    const realPaseoHome = await this.realpathOf(this.options.paseoHome);
    if (!this.personal.paseoHomes.includes(realPaseoHome)) {
      this.personal.paseoHomes.push(realPaseoHome);
    }
    // `os.tmpdir()` is `/var/folders/…` on darwin and `realpath` spells it
    // `/private/var/folders/…`, and a read arrives as its real path, so the configured spelling
    // alone would miss D12's scratch entirely.
    // Snapshotted, not iterated live: the loop pushes into the same array.
    const configuredTmpDirs = this.personal.tmpDirs.slice();
    for (const tmpDir of configuredTmpDirs) {
      const realTmpDir = await this.realpathOf(tmpDir);
      if (!this.personal.tmpDirs.includes(realTmpDir)) this.personal.tmpDirs.push(realTmpDir);
    }
  }

  /** The path as named and every path its symlinks point at on the way to the real file. */
  private async symlinkChain(namedPath: string): Promise<string[]> {
    const names = [path.resolve(namedPath)];
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
      const current = names[names.length - 1]!;
      const link = await this.fs.lstat(current).catch(() => null);
      if (!link?.isSymbolicLink()) break;
      const target = await this.fs.readlink(current).catch(() => null);
      if (target === null) break;
      names.push(path.resolve(path.dirname(current), target));
    }
    return names;
  }

  /** The nearest directory at or above the file's that holds a `.git`, as git finds its work tree. */
  private async workTreeOf(realPath: string): Promise<string | null> {
    let directory = path.dirname(realPath);
    for (;;) {
      if (await this.fs.lstat(path.join(directory, ".git")).catch(() => null)) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Shadow: judged after the read, from what it loaded.
  // -------------------------------------------------------------------------------------------

  private async onPostRead(event: FileReadHookEvent, hook: HookFields, at: number): Promise<void> {
    if (hook.toolName === "Bash") {
      await this.noteCopies(hook, hook.cwd ?? event.agentCwd, at).catch((error: unknown) => {
        this.logger.debug({ err: error }, "read check: copy taint failed");
      });
    }
    const config = this.refreshLiveSnapshot();
    const pending = hook.toolUseId ? this.pending.get(hook.toolUseId) : undefined;
    if (hook.toolUseId) this.pending.delete(hook.toolUseId);
    const read = recognizeRead({
      toolName: hook.toolName,
      toolInput: hook.toolInput,
      cwd: hook.cwd ?? event.agentCwd,
      home: this.options.homeDir,
    });
    if (!read) return;
    const measured = measure(read, hook.toolResponse);
    let compoundCounted = false;
    const state = this.stateFor(event.agentId);
    const contextTokens = measured ? estimateReadTokens(measured.charactersPerFile) : null;

    // A read live mode already judged: settle its measurement, never judge it twice.
    const liveSavingsId = pending?.live ? await pending.live.catch(() => null) : null;
    // Finding #4: a refused name on any file this call touched keeps the whole ring entry out,
    // even for Bash, whose ring item never shows the path itself. Finding #8: one ring entry per
    // call, not one per file — a compound Bash line would otherwise push the identical entry
    // once per file it named.
    let ringRefused = false;

    for (const file of read.files) {
      const realPath = await this.realpathOf(file.path);
      if (this.isRefusedForRing(file.path, realPath)) ringRefused = true;
      this.noteRead(event.agentId, realPath, read.tool, at, contextTokens);
      this.validation.noteRead(event.agentId, realPath, at);
      const signalMark = this.validation.mark();
      if (liveSavingsId && read.files.length === 1) {
        this.settle(liveSavingsId, { contextTokens, estimated: false });
      } else if (pending?.retryOfDeny) {
        // Goes through unchecked: nothing to judge.
      } else if (read.compound) {
        // Its output may hold more than one file's text: counted once, never judged.
        if (!compoundCounted) this.countNotAsked("compound");
        compoundCounted = true;
      } else {
        await this.judgeShadow({
          event,
          at,
          hook,
          read,
          file,
          realPath,
          measured,
          contextTokens,
          config,
          state,
          signalMark,
        });
      }
    }
    // KTD-2: pushed after every file is judged, so it never appears in its own `recent`.
    if (!ringRefused) this.pushRing(hook.subagentId, readRingItem(hook, read, read.files[0]!));
  }

  private async judgeShadow(input: ShadowReadInput): Promise<void> {
    const reason = this.shadowGate(input);
    if (reason) return this.countNotAsked(reason);
    if (this.judging >= MAX_CONCURRENT_JUDGMENTS) return this.countNotAsked("saturated");
    this.judging += 1;
    try {
      await this.judgeClaimed(input);
    } finally {
      this.judging -= 1;
    }
  }

  /**
   * A read that passed the cheap rules claims its `path|range`, so a burst of the same read is one
   * call and the rest are repeats. A claim that ends with nothing recorded is released.
   */
  private async judgeClaimed(input: ShadowReadInput): Promise<void> {
    const { event, read, file, realPath, state } = input;
    const key = `${realPath}|${rangeKey(file.range)}`;
    state.judged.set(key, this.now());
    const eligibility = await this.eligibilityForShadow({
      agentId: event.agentId,
      agentCwd: event.agentCwd,
      namedPath: file.path,
      realPath,
    });
    if (!eligibility.eligible) {
      state.judged.delete(key);
      return this.countNotAsked(eligibility.reason);
    }
    const slice = await this.shadowSlice(input, eligibility.identity);
    if (slice.kind !== "text") {
      state.judged.delete(key);
      return this.countNotAsked(slice.kind);
    }
    const tokens = input.contextTokens ?? 0;
    const asked = await this.ask({
      event,
      read,
      namedPath: file.path,
      realPath,
      slice,
      tokens,
      toolUseId: input.hook.toolUseId,
      subagentId: input.hook.subagentId,
      deadlineMs: input.config?.timeoutMs ?? 5000,
      live: false,
    });
    if (!asked) {
      state.judged.delete(key);
      return;
    }
    const savingsId = this.recordInvolvement({
      asked,
      agentId: event.agentId,
      did: "read",
      changed: false,
      facts: {
        contextTokens: tokens,
        estimated: false,
        split: read.files.length > 1,
        subagent: input.hook.subagentId !== null,
        // R4: a subagent read judged against the parent's task because its own brief could not
        // be found.
        briefMissing: this.subagentBriefMissing(input.hook.subagentId, input.event.subagentBrief),
        // D12: the subtree this read came from, or null for an ordinary one. The ledger counts
        // these apart, and they never count toward the shadow-to-live evidence rule.
        shadowOnly: eligibility.shadowOnly,
      },
      tool: read.tool,
      pending: asked.answer.verdict === "would-skip",
    });
    if (savingsId && asked.answer.verdict === "would-skip") {
      this.validation.open({
        savingsId,
        agentId: event.agentId,
        path: realPath,
        spellings: [realPath, asked.displayPath, file.path],
        mode: "shadow",
        // From the read, not the verdict: a use while JEV was answering still counts.
        openedAt: input.at,
        signalsAfter: input.signalMark,
        rangeText: slice.text,
        after: asked.around.cursor,
        turnId: asked.around.turnId,
      });
    }
  }

  /**
   * The not-asked reason for a read that ran, from what is already in hand, in the order of "When
   * JEV is asked". The repeat rule runs before the path rules and the scope check: it is a map
   * lookup, and the scope check runs git.
   */
  private shadowGate(input: ShadowReadInput): JevNotAskedReason | null {
    const { measured, config, read, state } = input;
    if (measured?.dedup) return "dedup";
    if (!config || !this.options.jev.isActive("readCheck")) return "inactive";
    // Before the floor: an image or a PDF loads tokens its text length does not show.
    if (measured?.notText || read.notText) return "not-text";
    if (!measured || (input.contextTokens ?? 0) < config.minTokens) return "below-floor";
    const judgedAt = state.judged.get(`${input.realPath}|${rangeKey(input.file.range)}`);
    if (judgedAt !== undefined && this.now() - judgedAt < REPEAT_MS) return "repeat";
    return null;
  }

  /**
   * The range's text after the scope check passed, read here from the file the checks saw. A Bash
   * read sends it, never the command's output, which could hold anything the line printed. A
   * `Read` sends what it loaded only when that is the same text: a path that pointed elsewhere
   * when the tool opened it (a swapped symlink, `~` spelled two ways) sends nothing.
   */
  private async shadowSlice(
    input: ShadowReadInput,
    identity: ReadCheckFileIdentity,
  ): Promise<SliceResult> {
    const { measured } = input;
    if (input.read.tool === "Bash" || measured?.text == null) {
      const loaded = await this.loadRange(input.realPath, identity, input.file, input.read.filters);
      return loaded.kind === "text" ? loaded : { kind: loaded.kind };
    }
    const text = measured.text;
    const lines = measured.lines;
    const totalLines = lines?.total ?? text.split("\n").length;
    const firstLine = lines?.first ?? 1;
    const lastLine = lines ? lines.first + lines.count - 1 : totalLines;
    const onDisk = await this.loadRange(
      input.realPath,
      identity,
      { path: input.file.path, range: { kind: "lines", first: firstLine, last: lastLine } },
      [],
    );
    if (onDisk.kind !== "text") return { kind: onDisk.kind };
    if (!sameText(onDisk.text, text)) return { kind: "changed" };
    return { kind: "text", text, firstLine, lastLine, totalLines };
  }

  /** Builds the state and asks. Null when nothing came back worth a record. */
  private async ask(input: {
    event: FileReadHookEvent;
    read: RecognizedRead;
    /** As the tool named it, before the observer resolved it (R2, KTD-3). */
    namedPath: string;
    realPath: string;
    slice: RangeText;
    tokens: number;
    toolUseId: string | null;
    deadlineMs: number;
    live: boolean;
    /** The SDK's own id for the subagent this read ran inside, or null for a main agent (R1). */
    subagentId: string | null;
  }): Promise<Asked | null> {
    const { event, realPath, slice, subagentId } = input;
    const agent = this.options.agents.agent(event.agentId);
    const around = this.timelineAround(event.agentId, input.toolUseId);
    const displayPath = displayPathOf(realPath, event.agentCwd);
    // R1, R4: a subagent whose brief was found and has content is judged against its own brief
    // and its own recent calls. A subagent whose brief could not be found, or is content-free
    // (finding #5), falls back to the parent's, exactly as before this plan (`brief: missing`).
    const brief = this.subagentBriefMissing(subagentId, event.subagentBrief)
      ? null
      : (event.subagentBrief ?? null);
    // R2 searches this for every reader, subagent included; R3 only adds it to a main agent's
    // (or a brief-missing subagent's) `task` — a subagent with its own brief keeps the parent's
    // task to one line (R1), not the parent's turn prompt too.
    const latestPrompt = latestUserPromptOf(around.recent);
    const pinnedRecentLine = brief
      ? null
      : this.findPinnedSearchLine(
          event.agentId,
          input.toolUseId,
          around.turnId,
          displayPath,
          realPath,
        );
    const state = buildReadCheckState({
      title: agent?.title ?? null,
      assignment: this.assignmentOf(event.agentId, this.stateFor(event.agentId)),
      ...(brief ? { subagentBrief: brief } : { latestPrompt }),
      pinnedRecentLine,
      recent: brief ? (this.subagentRings.get(subagentId!)?.items ?? []) : around.recent,
      why: input.read.why,
      displayPath,
      size: describeSize({ ...slice, tokens: input.tokens }),
      rangeText: slice.text,
    });
    // R2, KTD-3: after the eligibility checks, before the JEV call. Only `task`, the current
    // turn's latest prompt, and recent assistant lines are searched, never `excerpt` or
    // `outline` — a path named only inside the content being judged says nothing about whether
    // the agent already knew to expect it.
    if (
      isNamedRead(
        { namedPath: input.namedPath, displayPath, realPath },
        {
          texts: [
            state.task,
            latestPrompt,
            ...state.recent.filter((line) => line.startsWith("assistant: ")),
          ],
        },
      )
    ) {
      this.countNotAsked("named");
      return null;
    }
    const outcome = await this.options.jev.decide({
      feature: "readCheck",
      callSite: input.live ? CALL_SITE_LIVE : CALL_SITE_SHADOW,
      state: { ...state },
      questions: READ_CHECK_QUESTIONS,
      scope: {
        cwds: [event.agentCwd],
        files: [realPath],
        baseCwd: event.agentCwd,
        agentIds: [event.agentId],
      },
      subject: { agentId: event.agentId },
      deadlineMs: input.deadlineMs,
      ...(input.live ? {} : { shadow: true as const }),
    });
    if (outcome.kind === "unavailable") {
      this.countNotAsked(notAskedReasonFor(outcome));
      return null;
    }
    // Nothing was sent: no record (docs/jev.md, "The record").
    if (outcome.kind === "failed" && outcome.meta === null) return null;
    return {
      callId: outcome.callId,
      kind: outcome.kind,
      answer:
        outcome.kind === "failed"
          ? readCheckAnswerOf(undefined)
          : readCheckAnswerOf(outcome.answers[READ_CHECK_QUESTION_ID]),
      agent,
      displayPath,
      around,
    };
  }

  private async loadRange(
    realPath: string,
    identity: ReadCheckFileIdentity,
    file: RecognizedFile,
    filters: RecognizedRead["filters"],
  ): Promise<SliceResult> {
    let buffer: Buffer;
    try {
      buffer = await this.fs.readFile(realPath, identity);
    } catch {
      return { kind: "changed" };
    }
    // Only the head of a large file is read: a range from its end would be the wrong text.
    const fromEnd = file.range.kind === "last-lines" || file.range.kind === "last-bytes";
    if (fromEnd && buffer.length >= MAX_OBSERVER_FILE_BYTES) return { kind: "not-text" };
    if (!hasTextBody(buffer)) return { kind: "not-text" };
    const slice = sliceRange(buffer.toString("utf8"), file.range);
    const text = filters.length > 0 ? applyFilters(slice.text, filters) : slice.text;
    return { kind: "text", ...slice, text };
  }

  private noteRead(
    agentId: string,
    realPath: string,
    tool: "Read" | "Bash",
    at: number,
    contextTokens: number | null,
  ): void {
    try {
      this.options.savings.noteRead({
        agentId,
        path: realPath,
        tool,
        at: new Date(at).toISOString(),
        contextTokens,
      });
    } catch {
      // Never reaches the agent.
    }
  }

  private settle(savingsId: string, facts: Record<string, string | number | boolean | null>): void {
    try {
      this.options.savings.settle(savingsId, facts);
    } catch {
      // Never reaches the agent.
    }
  }

  private recordInvolvement(input: {
    asked: Asked;
    agentId: string;
    did: "read" | "deny";
    changed: boolean;
    facts: Record<string, string | number | boolean | null>;
    tool: "Read" | "Bash";
    pending: boolean;
  }): string | null {
    const { asked } = input;
    const facts = {
      ...input.facts,
      tool: input.tool,
      model: asked.agent?.model ?? null,
      agentContextTokens: asked.agent?.contextTokens ?? null,
      choice: asked.answer.choice,
      confidence: asked.answer.confidence,
      verdict: asked.answer.verdict,
      charsPerToken: JEV_CHARS_PER_TOKEN,
    };
    try {
      return this.options.savings.record({
        feature: "readCheck",
        callSite: asked.kind === "shadow" ? CALL_SITE_SHADOW : CALL_SITE_LIVE,
        callId: asked.callId,
        agentId: input.agentId,
        workspaceId: asked.agent?.workspaceId ?? null,
        involvement: `Does this agent need ${asked.displayPath}?`,
        decision: {
          did: input.did,
          // The verdict the savings ledger prices (docs/jev.md, "Formulas"); a live deny is `did`.
          wouldBe: asked.kind === "failed" ? null : asked.answer.verdict,
          changed: input.changed,
          detail: facts,
        },
        facts,
        pending: input.pending,
      });
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Live (D11): a large read of an agent in the live share waits up to `liveTimeoutMs`.
  // -------------------------------------------------------------------------------------------

  private maybeHold(event: FileReadHookEvent, hook: HookFields, at: number): FileReadHold | null {
    const read = recognizeRead({
      toolName: hook.toolName,
      toolInput: hook.toolInput,
      cwd: hook.cwd ?? event.agentCwd,
      home: this.options.homeDir,
    });
    const single =
      read && read.files.length === 1 && !read.notText && !read.compound ? read.files[0]! : null;
    if (!read || !single) return null;
    const state = this.stateFor(event.agentId);
    const config = this.refreshLiveSnapshot();
    const lexical = path.resolve(single.path);
    // The second read of a denied path always goes through, unchecked. Denied paths are kept
    // as the agent spelled them and as their real paths.
    if (state.denied.has(lexical)) {
      this.notePending(event, hook, at, null, true);
      return null;
    }
    const now = this.now();
    const deniesLastHour = state.denies.filter((t) => now - t < HOUR_MS).length;
    const regretsLastHour = state.regrets.filter((t) => now - t < HOUR_MS).length;
    if (
      !config ||
      state.edited.has(lexical) ||
      deniesLastHour >= config.maxDeniesPerAgentPerHour ||
      regretsLastHour >= READ_CHECK_MAX_REGRETS_PER_HOUR
    ) {
      return null;
    }

    // The verdict settles once: a deny, or null at the deadline or when the judgment ends. A
    // deny that lands after the deadline is never given, so the read and the record agree.
    const gate = { open: true };
    let resolveVerdict: (value: { denyReason: string } | null) => void = () => undefined;
    const verdict = new Promise<{ denyReason: string } | null>((resolve) => {
      resolveVerdict = resolve;
    });
    const settleVerdict = (value: { denyReason: string } | null): boolean => {
      if (!gate.open) return false;
      gate.open = false;
      resolveVerdict(value);
      return true;
    };
    const timer = setTimeout(() => settleVerdict(null), config.liveTimeoutMs);
    timer.unref?.();
    const judged = this.judgeLive({
      event,
      hook,
      read,
      file: single,
      config,
      signalMark: this.validation.mark(),
      settleVerdict,
    })
      .catch((error) => {
        this.logger.debug({ err: error }, "read check: live judgment failed; the read runs");
        return null;
      })
      .finally(() => {
        clearTimeout(timer);
        settleVerdict(null);
      });
    this.track(judged);
    this.notePending(event, hook, at, judged);
    return { verdict, timeoutMs: config.liveTimeoutMs };
  }

  /** Resolves the savings id of a live record whose read ran, for Post to settle; else null. */
  private async judgeLive(input: LiveReadInput): Promise<string | null> {
    if (this.judging >= MAX_CONCURRENT_JUDGMENTS) return null;
    this.judging += 1;
    try {
      return await this.judgeLiveClaimed(input);
    } finally {
      this.judging -= 1;
    }
  }

  private async judgeLiveClaimed(input: LiveReadInput): Promise<string | null> {
    const startedAt = this.now();
    const prepared = await this.prepareLive(input);
    if (!prepared) return null;
    const { event, read, file, config } = input;
    const asked = await this.ask({
      event,
      read,
      namedPath: file.path,
      realPath: prepared.realPath,
      slice: prepared.slice,
      tokens: prepared.tokens,
      toolUseId: null,
      subagentId: input.hook.subagentId,
      deadlineMs: Math.max(1, config.liveTimeoutMs - (this.now() - startedAt)),
      live: true,
    });
    if (!asked) return null;
    const state = this.stateFor(event.agentId);
    const now = this.now();
    const subagentId = input.hook.subagentId;
    // R4, KTD-4: a subagent whose brief could not be found was judged against a task the agent
    // never got to see — never deny on that basis. A `named` read never reaches here (`ask()`
    // already returned null for one), so this is a defensive restatement of that rule, not a new
    // path to it.
    const subagentBriefMissing = this.subagentBriefMissing(subagentId, event.subagentBrief);
    const decision = decideLiveDeny({
      answer: asked.answer,
      answered: asked.kind === "answered",
      plainRead: read.files.length === 1,
      deniedBefore: state.denied.has(prepared.realPath),
      editedBefore: state.edited.has(prepared.realPath),
      deniesLastHour: state.denies.filter((t) => now - t < HOUR_MS).length,
      regretsLastHour: state.regrets.filter((t) => now - t < HOUR_MS).length,
      maxDeniesPerAgentPerHour: config.maxDeniesPerAgentPerHour,
      subagentBriefMissing,
      named: false,
    });
    const facts = {
      contextTokens: prepared.tokens,
      estimated: true,
      split: false,
      subagent: subagentId !== null,
      briefMissing: subagentBriefMissing,
      liveReason: decision.deny ? null : decision.reason,
    };
    if (!decision.deny) {
      return this.recordInvolvement({
        asked,
        agentId: event.agentId,
        did: "read",
        changed: false,
        facts,
        tool: read.tool,
        pending: false,
      });
    }
    return this.deny({ input, asked, prepared, facts });
  }

  /**
   * Everything code checks before a live read is worth holding: the switch, the edit and repeat
   * rules, the size from the file's metadata, then the path rules and scope, then the exact size
   * (smaller reads are judged after they run, as in shadow). The size bound comes first so a small
   * read never waits on git.
   */
  private async prepareLive(
    input: LiveReadInput,
  ): Promise<{ realPath: string; slice: RangeText; tokens: number } | null> {
    const { event, read, file, config } = input;
    if (!this.options.jev.isActive("readCheck")) return null;
    const realPath = await this.realpathOf(file.path);
    const state = this.stateFor(event.agentId);
    if (state.edited.has(realPath) || state.denied.has(realPath)) return null;
    const key = `${realPath}|${rangeKey(file.range)}`;
    const judgedAt = state.judged.get(key);
    if (judgedAt !== undefined && this.now() - judgedAt < REPEAT_MS) return null;
    const stat = await this.fs.stat(realPath).catch(() => null);
    if (!stat?.isFile() || this.maxReadTokens(stat.size, file) < config.liveMinTokens) {
      return null;
    }
    const eligibility = await this.eligibilityForLive({
      agentId: event.agentId,
      agentCwd: event.agentCwd,
      namedPath: file.path,
      realPath,
    });
    if (!eligibility.eligible) return null;
    const loaded = await this.loadRange(realPath, eligibility.identity, file, read.filters);
    if (loaded.kind !== "text") return null;
    const slice: RangeText = loaded;
    const characters = read.tool === "Read" ? readToolCharacters(slice.text) : slice.text.length;
    const tokens = estimateReadTokens(characters);
    if (tokens < config.liveMinTokens) return null;
    state.judged.set(key, this.now());
    return { realPath, slice, tokens };
  }

  /**
   * The most tokens a read of a file this size could load, from its size alone: every byte a
   * character, and at most one line per byte (or the range's line count), each with Read's
   * numbering. An upper bound, so a read under it is surely under the live floor.
   */
  private maxReadTokens(size: number, file: RecognizedFile): number {
    const range = file.range;
    const bytes =
      range.kind === "first-bytes" || range.kind === "last-bytes"
        ? Math.min(size, range.count)
        : size;
    let lines = bytes + 1;
    if (range.kind === "lines" && range.last !== null) {
      lines = Math.min(lines, Math.max(0, range.last - range.first + 1));
    } else if (range.kind === "last-lines") {
      lines = Math.min(lines, range.count);
    }
    return estimateReadTokens(bytes + READ_TOOL_LINE_OVERHEAD * lines);
  }

  /** Denies the held read once, unless the deadline let it through first. */
  private deny(args: {
    input: LiveReadInput;
    asked: Asked;
    prepared: { realPath: string; slice: RangeText; tokens: number };
    facts: Record<string, string | number | boolean | null>;
  }): string | null {
    const { input, asked, prepared } = args;
    const { event, read, file } = input;
    const confidence = asked.answer.confidence ?? 0;
    const denyReason = formatReadDenial({
      displayPath: asked.displayPath,
      tokens: prepared.tokens,
      confidence,
      tool: read.tool,
      hasJevFileTools: asked.agent?.labels[JEV_TOOLS_LABEL] === "on",
    });
    if (!input.settleVerdict({ denyReason })) {
      // The deadline passed first and the read ran: a live answer that changed nothing.
      return this.recordInvolvement({
        asked,
        agentId: event.agentId,
        did: "read",
        changed: false,
        facts: { ...args.facts, liveReason: "deadline" },
        tool: read.tool,
        pending: false,
      });
    }
    const now = this.now();
    const state = this.stateFor(event.agentId);
    state.denied.add(prepared.realPath);
    state.denied.add(path.resolve(file.path));
    state.denies.push(now);
    const savingsId = this.recordInvolvement({
      asked,
      agentId: event.agentId,
      did: "deny",
      changed: true,
      facts: args.facts,
      tool: read.tool,
      pending: true,
    });
    try {
      this.options.jev.decisions.record({
        agentId: event.agentId,
        callId: asked.callId,
        feature: "readCheck",
        question: `Does this agent need ${asked.displayPath}?`,
        verdict: `not_needed (${confidence.toFixed(2)})`,
        confidence: asked.answer.confidence,
        action: `denied the read once (about ${prepared.tokens.toLocaleString("en-US")} tokens)`,
        applied: true,
        mode: "live",
        wouldBe: "deny",
        ...(savingsId ? { savingsId } : {}),
      });
    } catch {
      // Never reaches the agent.
    }
    if (savingsId) {
      this.validation.open({
        savingsId,
        agentId: event.agentId,
        path: prepared.realPath,
        spellings: [prepared.realPath, asked.displayPath, file.path],
        mode: "live",
        openedAt: now,
        signalsAfter: input.signalMark,
        rangeText: prepared.slice.text,
        after: asked.around.cursor,
        turnId: asked.around.turnId,
      });
    }
    // Denied: the read never runs, so there is no PostToolUse to settle.
    return null;
  }
}
