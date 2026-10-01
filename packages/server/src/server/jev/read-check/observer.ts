import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { JEV_TOOLS_LABEL } from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type {
  JevDecideInput,
  JevNotAskedReason,
  JevOutcome,
  JevSavingsSink,
  JevService,
} from "../contract.js";
import type { ResolvedJevConfig } from "../config.js";
import {
  decideLiveDeny,
  formatReadDenial,
  isLiveShareAgent,
  READ_CHECK_MAX_REGRETS_PER_HOUR,
  READ_CHECK_QUESTION_ID,
  readCheckAnswerOf,
  type ReadCheckAnswer,
} from "./decision.js";
import { isInside, isSecretShapedPath, readCheckDeniedRoots } from "./paths.js";
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
  READ_CHECK_CHARS_PER_TOKEN,
  READ_CHECK_QUESTIONS,
  readToolCharacters,
  sliceRange,
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

export interface FileReadHookEvent {
  /** The Paseo agent that owns the session; a subagent's calls carry its parent's id. */
  agentId: string;
  /** The session's cwd. A read outside it is never judged. */
  agentCwd: string;
  /** The SDK's hook input, as received. */
  input: unknown;
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

export interface ReadCheckFileSystem {
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer>;
}

export interface ReadCheckObserverOptions {
  jev: Pick<JevService, "isActive" | "checkScope" | "decide" | "decisions">;
  savings: JevSavingsSink;
  /** `agents.jev.readCheck`, or null when the config cannot be read. Synchronous and cached. */
  readConfig: () => ReadCheckConfig | null;
  agents: ReadCheckAgentSource;
  homeDir: string;
  paseoHome: string;
  logger: Logger;
  now?: () => number;
  fs?: ReadCheckFileSystem;
  /** How hook work is queued off the hook's tick. Default `setImmediate`. */
  defer?: (work: () => void) => void;
  /** The sweep's period. Default 60 s; 0 disables the timer (tests call `sweep`). */
  sweepIntervalMs?: number;
}

const CALL_SITE_SHADOW = "read-check.shadow";
const CALL_SITE_LIVE = "read-check.live";
const REPEAT_MS = 30 * 60_000;
const PENDING_MS = 10 * 60_000;
const AGENT_IDLE_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const RECENT_TAIL_ROWS = 16;
const SCAN_ROWS = 200;
/** A file larger than this is never read whole by the observer; its estimate is from its size. */
const MAX_OBSERVER_FILE_BYTES = 8 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

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
  /** The text the agent saw, when one file was read; null for several. */
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

function measure(read: RecognizedRead, response: unknown): Measured | null {
  const result = record(response);
  if (read.tool === "Read") {
    if (result?.["type"] === "file_unchanged") {
      return { charactersPerFile: 0, text: null, notText: false, dedup: true, lines: null };
    }
    const file = record(result?.["file"]);
    const content = file?.["content"];
    if (result?.["type"] !== "text" || typeof content !== "string") {
      // An image, a PDF, a notebook: counted, never judged.
      return result
        ? { charactersPerFile: 0, text: null, notText: true, dedup: false, lines: null }
        : null;
    }
    const first = typeof file?.["startLine"] === "number" ? file["startLine"] : 1;
    const count = typeof file?.["numLines"] === "number" ? file["numLines"] : 0;
    const total = typeof file?.["totalLines"] === "number" ? file["totalLines"] : count;
    return {
      charactersPerFile: readToolCharacters(content),
      text: content,
      notText: read.notText || content.includes("\u0000"),
      dedup: false,
      lines: { first, count, total },
    };
  }
  if (typeof response === "string") {
    return {
      charactersPerFile: response.length / read.files.length,
      text: read.files.length === 1 ? response : null,
      notText: response.slice(0, BINARY_PROBE_BYTES).includes("\u0000"),
      dedup: false,
      lines: null,
    };
  }
  const stdout = typeof result?.["stdout"] === "string" ? result["stdout"] : "";
  const stderr = typeof result?.["stderr"] === "string" ? result["stderr"] : "";
  if (!result || result["isImage"] === true) {
    return result
      ? { charactersPerFile: 0, text: null, notText: true, dedup: false, lines: null }
      : null;
  }
  return {
    charactersPerFile: (stdout.length + stderr.length) / read.files.length,
    text: read.files.length === 1 ? stdout : null,
    notText: stdout.slice(0, BINARY_PROBE_BYTES).includes("\u0000"),
    dedup: false,
    lines: null,
  };
}

function hasTextBody(buffer: Buffer): boolean {
  return !buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

function displayPathOf(realPath: string, agentCwd: string): string {
  const relative = path.relative(agentCwd, realPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : realPath;
}

function wouldBeOf(answer: ReadCheckAnswer): string {
  switch (answer.verdict) {
    case "would-skip":
      return "skip";
    case "would-narrow":
      return "narrow";
    case "needed":
      return "read";
  }
}

/** A call that sent nothing is a daily counter, never a record. */
function notAskedReasonFor(
  outcome: Extract<JevOutcome, { kind: "unavailable" }>,
): JevNotAskedReason {
  return outcome.reason === "excluded" ? "excluded" : "inactive";
}

const defaultFs: ReadCheckFileSystem = {
  realpath: (filePath) => fsPromises.realpath(filePath),
  readFile: async (filePath) => {
    const handle = await fsPromises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("not a regular file");
      const length = Math.min(stat.size, MAX_OBSERVER_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return buffer;
    } finally {
      await handle.close();
    }
  },
};

export class ReadCheckObserver implements FileReadObserver {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fs: ReadCheckFileSystem;
  private readonly defer: (work: () => void) => void;
  private readonly validation: ReadCheckValidation;
  private readonly agents = new Map<string, AgentReadState>();
  private readonly pending = new Map<string, PendingRead>();
  private readonly deniedRoots: string[];
  private liveSnapshot: LiveSnapshot = { enabled: false, live: false, liveShare: 0 };
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly options: ReadCheckObserverOptions) {
    this.logger = options.logger.child({ module: "jev-read-check" });
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? defaultFs;
    this.defer = options.defer ?? ((work) => setImmediate(work));
    this.deniedRoots = readCheckDeniedRoots({
      homeDir: options.homeDir,
      paseoHome: options.paseoHome,
    });
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
      for (const [id, pending] of [...this.pending]) {
        if (now - pending.at >= PENDING_MS) this.pending.delete(id);
      }
      for (const [agentId, state] of [...this.agents]) {
        for (const [key, at] of [...state.judged]) {
          if (now - at >= REPEAT_MS) state.judged.delete(key);
        }
        state.denies = state.denies.filter((at) => now - at < HOUR_MS);
        state.regrets = state.regrets.filter((at) => now - at < HOUR_MS);
        if (now - state.lastSeen >= AGENT_IDLE_MS && state.denied.size === 0) {
          this.agents.delete(agentId);
        }
      }
      for (const agentId of this.validation.agentsWithOpenWindows()) this.scanAgent(agentId);
      this.validation.expire(now);
    } catch (error) {
      this.logger.debug({ err: error }, "read check: sweep failed");
    }
  }

  /** Stops the sweep and waits for queued work. */
  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  /** Test seam: resolves once every queued piece of work has finished. */
  async idle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.inFlight.size === 0) return;
      await Promise.allSettled([...this.inFlight]);
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
    const index = toolUseId
      ? page.rows.findIndex((row) => row.item.type === "tool_call" && row.item.callId === toolUseId)
      : -1;
    const own = index >= 0 ? page.rows[index] : undefined;
    const before = index >= 0 ? page.rows.slice(0, index) : page.rows;
    const last = page.rows[page.rows.length - 1];
    return {
      recent: before.map((row) => row.item),
      cursor: own
        ? { epoch: page.epoch, seq: own.seq }
        : last
          ? { epoch: page.epoch, seq: last.seq }
          : null,
      turnId: own?.turnId ?? last?.turnId ?? null,
    };
  }

  /**
   * Rules 3 and 4 of "When JEV is asked": the agent's cwd, denied roots, secret names, then the
   * D7 scope check. Nothing here opens the file.
   */
  private async eligibility(input: {
    agentId: string;
    agentCwd: string;
    realPath: string;
  }): Promise<JevNotAskedReason | null> {
    const realCwd = await this.realpathOf(input.agentCwd);
    if (!isInside(input.realPath, realCwd)) return "outside-cwd";
    if (
      isSecretShapedPath(input.realPath) ||
      this.deniedRoots.some((root) => isInside(input.realPath, root))
    ) {
      return "secret-path";
    }
    const scope = await this.options.jev
      .checkScope({
        cwds: [input.agentCwd],
        files: [input.realPath],
        baseCwd: input.agentCwd,
        agentIds: [input.agentId],
      })
      .catch(() => "excluded" as const);
    return scope === "ok" ? null : "excluded";
  }

  private decideInput(input: {
    agentId: string;
    agentCwd: string;
    realPath: string;
    state: ReturnType<typeof buildReadCheckState>;
    deadlineMs: number;
    shadow: boolean;
    callSite: string;
  }): JevDecideInput {
    return {
      feature: "readCheck",
      callSite: input.callSite,
      state: { ...input.state },
      questions: READ_CHECK_QUESTIONS,
      scope: {
        cwds: [input.agentCwd],
        files: [input.realPath],
        baseCwd: input.agentCwd,
        agentIds: [input.agentId],
      },
      subject: { agentId: input.agentId },
      deadlineMs: input.deadlineMs,
      ...(input.shadow ? { shadow: true as const } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Shadow: judged after the read, from what it loaded.
  // -------------------------------------------------------------------------------------------

  private async onPostRead(event: FileReadHookEvent, hook: HookFields, at: number): Promise<void> {
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
    const state = this.stateFor(event.agentId);
    const contextTokens = measured ? estimateReadTokens(measured.charactersPerFile) : null;

    // A read live mode already judged: settle its measurement, never judge it twice.
    const liveSavingsId = pending?.live ? await pending.live.catch(() => null) : null;

    for (const file of read.files) {
      const realPath = await this.realpathOf(file.path);
      this.noteRead(event.agentId, realPath, read.tool, at, contextTokens);
      this.validation.noteRead(event.agentId, realPath, at);
      if (liveSavingsId && read.files.length === 1) {
        this.settle(liveSavingsId, { contextTokens, estimated: false });
        continue;
      }
      if (pending?.retryOfDeny) continue;
      await this.judgeShadow({
        event,
        hook,
        read,
        file,
        realPath,
        measured,
        contextTokens,
        config,
        state,
      });
    }
  }

  private async judgeShadow(input: {
    event: FileReadHookEvent;
    hook: HookFields;
    read: RecognizedRead;
    file: RecognizedFile;
    realPath: string;
    measured: Measured | null;
    contextTokens: number | null;
    config: ReadCheckConfig | null;
    state: AgentReadState;
  }): Promise<void> {
    const { event, read, file, realPath, measured, config, state } = input;
    if (measured?.dedup) return this.countNotAsked("dedup");
    if (!config || !this.options.jev.isActive("readCheck")) return this.countNotAsked("inactive");
    const tokens = input.contextTokens ?? 0;
    if (!measured || tokens < config.minTokens) return this.countNotAsked("below-floor");
    if (measured.notText || read.notText) return this.countNotAsked("not-text");
    const ineligible = await this.eligibility({
      agentId: event.agentId,
      agentCwd: event.agentCwd,
      realPath,
    });
    if (ineligible) return this.countNotAsked(ineligible);
    const key = `${realPath}|${rangeKey(file.range)}`;
    const judgedAt = state.judged.get(key);
    if (judgedAt !== undefined && this.now() - judgedAt < REPEAT_MS) {
      return this.countNotAsked("repeat");
    }

    // The scope check passed, so the file may be opened now. One file: what the agent saw.
    let rangeText = measured.text;
    let lines = measured.lines;
    if (rangeText === null) {
      // Several files in one Bash line: each is judged on its own range, read here.
      const loaded = await this.loadRange(realPath, file, []);
      if (!loaded) return this.countNotAsked("not-text");
      rangeText = loaded.text;
      lines = {
        first: loaded.firstLine,
        count: loaded.lastLine - loaded.firstLine + 1,
        total: loaded.totalLines,
      };
    }
    const totalLines = lines?.total ?? rangeText.split("\n").length;
    const firstLine = lines?.first ?? 1;
    const lastLine = lines ? lines.first + lines.count - 1 : totalLines;
    state.judged.set(key, this.now());

    const agent = this.options.agents.agent(event.agentId);
    const around = this.timelineAround(event.agentId, input.hook.toolUseId);
    const displayPath = displayPathOf(realPath, event.agentCwd);
    const jevState = buildReadCheckState({
      title: agent?.title ?? null,
      assignment: this.assignmentOf(event.agentId, state),
      recent: around.recent,
      why: read.why,
      displayPath,
      size: describeSize({ firstLine, lastLine, totalLines, tokens }),
      rangeText,
    });
    const outcome = await this.options.jev.decide(
      this.decideInput({
        agentId: event.agentId,
        agentCwd: event.agentCwd,
        realPath,
        state: jevState,
        deadlineMs: config.timeoutMs,
        shadow: true,
        callSite: CALL_SITE_SHADOW,
      }),
    );
    if (outcome.kind === "unavailable") {
      return this.countNotAsked(notAskedReasonFor(outcome));
    }
    if (outcome.kind === "failed" && outcome.meta === null) return;

    const answer =
      outcome.kind === "failed"
        ? readCheckAnswerOf(undefined)
        : readCheckAnswerOf(outcome.answers[READ_CHECK_QUESTION_ID]);
    const savingsId = this.recordInvolvement({
      callId: outcome.callId,
      agentId: event.agentId,
      agent,
      displayPath,
      did: "read",
      wouldBe: outcome.kind === "failed" ? null : wouldBeOf(answer),
      changed: false,
      answer,
      facts: {
        contextTokens: tokens,
        estimated: false,
        split: read.files.length > 1,
        subagent: input.hook.subagentId !== null,
      },
      tool: read.tool,
      pending: answer.verdict === "would-skip",
    });
    if (savingsId && answer.verdict === "would-skip") {
      this.validation.open({
        savingsId,
        agentId: event.agentId,
        path: realPath,
        spellings: [realPath, displayPath, file.path],
        mode: "shadow",
        openedAt: this.now(),
        rangeText,
        after: around.cursor,
        turnId: around.turnId,
      });
    }
  }

  private async loadRange(
    realPath: string,
    file: RecognizedFile,
    filters: RecognizedRead["filters"],
  ): Promise<ReturnType<typeof sliceRange> | null> {
    let buffer: Buffer;
    try {
      buffer = await this.fs.readFile(realPath);
    } catch {
      return null;
    }
    if (!hasTextBody(buffer)) return null;
    const slice = sliceRange(buffer.toString("utf8"), file.range);
    return filters.length > 0 ? { ...slice, text: applyFilters(slice.text, filters) } : slice;
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
    callId: string;
    agentId: string;
    agent: ReadCheckAgentInfo | null;
    displayPath: string;
    did: string;
    wouldBe: string | null;
    changed: boolean;
    answer: ReadCheckAnswer;
    facts: Record<string, string | number | boolean | null>;
    tool: "Read" | "Bash";
    pending: boolean;
  }): string | null {
    const facts = {
      ...input.facts,
      tool: input.tool,
      model: input.agent?.model ?? null,
      agentContextTokens: input.agent?.contextTokens ?? null,
      choice: input.answer.choice,
      confidence: input.answer.confidence,
      verdict: input.answer.verdict,
      charsPerToken: READ_CHECK_CHARS_PER_TOKEN,
    };
    try {
      return this.options.savings.record({
        feature: "readCheck",
        callSite: input.did === "deny" ? CALL_SITE_LIVE : CALL_SITE_SHADOW,
        callId: input.callId,
        agentId: input.agentId,
        workspaceId: input.agent?.workspaceId ?? null,
        involvement: `Does this agent need ${input.displayPath}?`,
        decision: {
          did: input.did,
          wouldBe: input.wouldBe,
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
    const single = read && read.files.length === 1 && !read.notText ? read.files[0]! : null;
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
    const judged = this.judgeLive({ event, hook, read, file: single, config, settleVerdict })
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
  private async judgeLive(input: {
    event: FileReadHookEvent;
    hook: HookFields;
    read: RecognizedRead;
    file: RecognizedFile;
    config: ReadCheckConfig;
    /** False once the read was let through: a deny then is never given. */
    settleVerdict: (value: { denyReason: string } | null) => boolean;
  }): Promise<string | null> {
    const { event, hook, read, file, config } = input;
    const startedAt = this.now();
    if (!this.options.jev.isActive("readCheck")) return null;
    const realPath = await this.realpathOf(file.path);
    const state = this.stateFor(event.agentId);
    if (state.edited.has(realPath) || state.denied.has(realPath)) return null;
    if (await this.eligibility({ agentId: event.agentId, agentCwd: event.agentCwd, realPath })) {
      return null;
    }
    const loaded = await this.loadRange(realPath, file, read.filters);
    if (!loaded) return null;
    const characters = read.tool === "Read" ? readToolCharacters(loaded.text) : loaded.text.length;
    const tokens = estimateReadTokens(characters);
    // Smaller reads are judged after they run, as in shadow.
    if (tokens < config.liveMinTokens) return null;
    const key = `${realPath}|${rangeKey(file.range)}`;
    const judgedAt = state.judged.get(key);
    if (judgedAt !== undefined && this.now() - judgedAt < REPEAT_MS) return null;
    state.judged.set(key, this.now());

    const agent = this.options.agents.agent(event.agentId);
    const around = this.timelineAround(event.agentId, null);
    const displayPath = displayPathOf(realPath, event.agentCwd);
    const jevState = buildReadCheckState({
      title: agent?.title ?? null,
      assignment: this.assignmentOf(event.agentId, state),
      recent: around.recent,
      why: read.why,
      displayPath,
      size: describeSize({
        firstLine: loaded.firstLine,
        lastLine: loaded.lastLine,
        totalLines: loaded.totalLines,
        tokens,
      }),
      rangeText: loaded.text,
    });
    const remaining = Math.max(1, config.liveTimeoutMs - (this.now() - startedAt));
    const outcome = await this.options.jev.decide(
      this.decideInput({
        agentId: event.agentId,
        agentCwd: event.agentCwd,
        realPath,
        state: jevState,
        deadlineMs: remaining,
        shadow: false,
        callSite: CALL_SITE_LIVE,
      }),
    );
    if (outcome.kind === "unavailable") {
      this.countNotAsked(notAskedReasonFor(outcome));
      return null;
    }
    if (outcome.kind === "failed" && outcome.meta === null) return null;
    const answer =
      outcome.kind === "failed"
        ? readCheckAnswerOf(undefined)
        : readCheckAnswerOf(outcome.answers[READ_CHECK_QUESTION_ID]);
    const now = this.now();
    const decision = decideLiveDeny({
      answer,
      answered: outcome.kind === "answered",
      plainRead: read.files.length === 1,
      deniedBefore: state.denied.has(realPath),
      editedBefore: state.edited.has(realPath),
      deniesLastHour: state.denies.filter((t) => now - t < HOUR_MS).length,
      regretsLastHour: state.regrets.filter((t) => now - t < HOUR_MS).length,
      maxDeniesPerAgentPerHour: config.maxDeniesPerAgentPerHour,
    });
    const facts = {
      contextTokens: tokens,
      estimated: true,
      split: false,
      subagent: hook.subagentId !== null,
      liveReason: decision.deny ? null : decision.reason,
    };
    if (!decision.deny) {
      return this.recordInvolvement({
        callId: outcome.callId,
        agentId: event.agentId,
        agent,
        displayPath,
        did: "read",
        wouldBe: outcome.kind === "failed" ? null : wouldBeOf(answer),
        changed: false,
        answer,
        facts,
        tool: read.tool,
        pending: false,
      });
    }

    const denyReason = formatReadDenial({
      displayPath,
      tokens,
      confidence: answer.confidence ?? 0,
      tool: read.tool,
      hasJevFileTools: agent?.labels[JEV_TOOLS_LABEL] === "on",
    });
    if (!input.settleVerdict({ denyReason })) {
      // The deadline passed first and the read ran: a live answer that changed nothing.
      return this.recordInvolvement({
        callId: outcome.callId,
        agentId: event.agentId,
        agent,
        displayPath,
        did: "read",
        wouldBe: "deny",
        changed: false,
        answer,
        facts: { ...facts, liveReason: "deadline" },
        tool: read.tool,
        pending: false,
      });
    }
    state.denied.add(realPath);
    state.denied.add(path.resolve(file.path));
    state.denies.push(now);
    const savingsId = this.recordInvolvement({
      callId: outcome.callId,
      agentId: event.agentId,
      agent,
      displayPath,
      did: "deny",
      wouldBe: "deny",
      changed: true,
      answer,
      facts,
      tool: read.tool,
      pending: true,
    });
    try {
      this.options.jev.decisions.record({
        agentId: event.agentId,
        callId: outcome.callId,
        feature: "readCheck",
        question: `Does this agent need ${displayPath}?`,
        verdict: `not_needed (${(answer.confidence ?? 0).toFixed(2)})`,
        confidence: answer.confidence,
        action: `denied the read once (about ${tokens.toLocaleString("en-US")} tokens)`,
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
        path: realPath,
        spellings: [realPath, displayPath, file.path],
        mode: "live",
        openedAt: now,
        rangeText: loaded.text,
        after: around.cursor,
        turnId: around.turnId,
      });
    }
    // Denied: the read never runs, so there is no PostToolUse to settle.
    return null;
  }
}
