import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type {
  JevAnswer,
  JevCost,
  JevFeatureId,
  JevLane,
  JevQuestions,
  JevState,
  JevWireRequest,
} from "./contract.js";
import { JEV_AGENT_TOOLS_CONTENT_FIELDS } from "./contract.js";
import type { JevLedgerEntry } from "./ledger.js";

/**
 * Bounded on-disk retention of what left the machine and what came back (docs/jev.md, "Audit").
 * `append` is queued and written serially, off the caller's path, so a multi-megabyte
 * `JSON.stringify` and rewrite cycle never blocks the event loop the daemon-vitals wedge
 * detector watches (docs/daemon-vitals.md).
 */

const MAX_STATE_LINE_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60_000;
const AUDIT_FILE_NAME = "audit.jsonl";
const ROTATED_FILE_NAME = "audit.1.jsonl";

export interface JevAuditLine {
  v: 1;
  callId: string;
  at: string;
  feature: JevFeatureId;
  lane: JevLane;
  callSite: string;
  /**
   * `person` for the `interactive` lane: a question asked over `jev.ask`, which no daemon code
   * calls. Everything else the daemon asked on its own.
   */
  initiator: "person" | "daemon";
  model: string;
  outcome: "answered" | "shadow" | "failed";
  reason: string | null;
  attempts: number;
  elapsedMs: number;
  stateBytes: number;
  bodyBytes: number;
  redactions: number;
  cost: JevCost;
  /** The redacted state, or its first 16 KB as a string when `stateTruncated`. */
  state: unknown;
  /** Over the full serialized state, never the truncated form. */
  stateSha256: string;
  stateBytesTotal: number;
  stateTruncated: boolean;
  questions: JevQuestions;
  answers: Record<string, JevAnswer> | null;
}

export interface JevAuditLedgerFields extends Pick<
  JevLedgerEntry,
  | "callId"
  | "at"
  | "feature"
  | "callSite"
  | "attempts"
  | "elapsedMs"
  | "stateBytes"
  | "bodyBytes"
  | "redactions"
  | "cost"
> {
  outcome: "answered" | "shadow" | "failed";
  reason: string | null;
  model: string;
}

export interface BuildJevAuditLineInput {
  lane: JevLane;
  /** Already redacted. */
  request: JevWireRequest;
  answers: Record<string, JevAnswer> | null;
  ledger: JevAuditLedgerFields;
}

function hashOf(content: string): { sha256: string; bytes: number } {
  const buffer = Buffer.from(content, "utf8");
  return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}

/**
 * `agentTools` only: replaces `state.content` and every value of `state.files` with
 * `{ sha256, bytes }`. Every other field is kept, like a `control` state.
 */
function hashAgentToolsState(state: JevState): JevState {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return state;
  const record: Record<string, unknown> = { ...(state as Record<string, unknown>) };

  const contentField = JEV_AGENT_TOOLS_CONTENT_FIELDS.single;
  const content = record[contentField];
  if (typeof content === "string") record[contentField] = hashOf(content);

  const filesField = JEV_AGENT_TOOLS_CONTENT_FIELDS.multi;
  const files = record[filesField];
  if (typeof files === "object" && files !== null && !Array.isArray(files)) {
    const hashedFiles: Record<string, unknown> = {};
    for (const [filePath, fileContent] of Object.entries(files as Record<string, unknown>)) {
      hashedFiles[filePath] = typeof fileContent === "string" ? hashOf(fileContent) : fileContent;
    }
    record[filesField] = hashedFiles;
  }
  return record;
}

export function buildJevAuditLine(input: BuildJevAuditLineInput): JevAuditLine {
  const state =
    input.lane === "agentTools" ? hashAgentToolsState(input.request.state) : input.request.state;
  const serialized = JSON.stringify(state);
  const buffer = Buffer.from(serialized, "utf8");
  const truncated = buffer.length > MAX_STATE_LINE_BYTES;
  return {
    v: 1,
    callId: input.ledger.callId,
    at: input.ledger.at,
    feature: input.ledger.feature,
    lane: input.lane,
    callSite: input.ledger.callSite,
    initiator: input.lane === "interactive" ? "person" : "daemon",
    model: input.ledger.model,
    outcome: input.ledger.outcome,
    reason: input.ledger.reason,
    attempts: input.ledger.attempts,
    elapsedMs: input.ledger.elapsedMs,
    stateBytes: input.ledger.stateBytes,
    bodyBytes: input.ledger.bodyBytes,
    redactions: input.ledger.redactions,
    cost: input.ledger.cost,
    state: truncated ? buffer.subarray(0, MAX_STATE_LINE_BYTES).toString("utf8") : state,
    stateSha256: createHash("sha256").update(buffer).digest("hex"),
    stateBytesTotal: buffer.length,
    stateTruncated: truncated,
    questions: input.request.questions,
    answers: input.answers,
  };
}

export interface JevAuditOptions {
  /** `$PASEO_HOME/jev`. */
  dir: string;
  logger: Logger;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface JevAuditAppendConfig {
  enabled: boolean;
  maxBytes: number;
  retainDays: number;
}

function isRecentLine(line: string, horizonMs: number): boolean {
  try {
    const parsed = JSON.parse(line) as { at?: unknown };
    return typeof parsed.at === "string" ? Date.parse(parsed.at) >= horizonMs : true;
  } catch {
    // An unparsable line is kept rather than silently dropped.
    return true;
  }
}

export class JevAudit {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private writeChain: Promise<void> = Promise.resolve();
  private currentSize = 0;

  constructor(options: JevAuditOptions) {
    this.dir = options.dir;
    this.logger = options.logger.child({ module: "jev-audit" });
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
  }

  async init(config: { retainDays: number }): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      if (this.platform !== "win32") {
        await this.narrowMode(this.dir, 0o700);
        await this.narrowMode(this.currentPath(), 0o600);
        await this.narrowMode(this.rotatedPath(), 0o600);
      }
      await this.pruneFile(this.currentPath(), config.retainDays);
      await this.pruneFile(this.rotatedPath(), config.retainDays);
      const stat = await fs.stat(this.currentPath()).catch(() => null);
      this.currentSize = stat?.size ?? 0;
    } catch (error) {
      this.logger.warn({ err: error, dir: this.dir }, "jev: audit init failed");
    }
  }

  /** Enqueues the line; the write happens off the caller's path. Never throws. */
  append(line: JevAuditLine, config: JevAuditAppendConfig): void {
    if (!config.enabled) return;
    this.writeChain = this.writeChain.then(() =>
      this.appendOne(line, config).catch((error) => {
        this.logger.warn({ err: error, callId: line.callId }, "jev: audit append failed");
      }),
    );
  }

  /** Resolves once every append queued so far has landed. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async appendOne(
    line: JevAuditLine,
    config: { maxBytes: number; retainDays: number },
  ): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.currentSize + bytes > config.maxBytes) {
      await this.rotate(config.retainDays);
    }
    await fs.mkdir(
      this.dir,
      this.platform === "win32" ? { recursive: true } : { recursive: true, mode: 0o700 },
    );
    await fs.appendFile(
      this.currentPath(),
      text,
      this.platform === "win32" ? undefined : { mode: 0o600 },
    );
    this.currentSize += bytes;
  }

  private async rotate(retainDays: number): Promise<void> {
    await this.removeIfExists(this.rotatedPath());
    try {
      await fs.rename(this.currentPath(), this.rotatedPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.currentSize = 0;
    await this.pruneFile(this.rotatedPath(), retainDays);
  }

  private async pruneFile(filePath: string, retainDays: number): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return;
    }
    const horizon = this.now() - retainDays * DAY_MS;
    const lines = text.split("\n").filter((line) => line.length > 0);
    const kept = lines.filter((line) => isRecentLine(line, horizon));
    if (kept.length === lines.length) return;
    const content = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await fs.writeFile(filePath, content, this.platform === "win32" ? undefined : { mode: 0o600 });
    if (filePath === this.currentPath()) this.currentSize = Buffer.byteLength(content, "utf8");
  }

  private async narrowMode(target: string, mode: number): Promise<void> {
    try {
      const stat = await fs.stat(target);
      if ((stat.mode & 0o777) > mode) await fs.chmod(target, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async removeIfExists(target: string): Promise<void> {
    try {
      await fs.rm(target, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private currentPath(): string {
    return path.join(this.dir, AUDIT_FILE_NAME);
  }

  private rotatedPath(): string {
    return path.join(this.dir, ROTATED_FILE_NAME);
  }
}
