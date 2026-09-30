import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * The D8 record for the JEV agent tools (docs/jev.md, "Cost, cache, latency"): one line per tool
 * call in `$PASEO_HOME/jev/tool-use.jsonl`, which `scripts/jev-tools-ab.ts` joins with the arm
 * labels and the agents' transcripts. The daemon log carries the same line, but daemon.log does not
 * outlive a restart for long enough to judge 50 agents, so this file is the one the report reads.
 *
 * Nothing here is file content or command text: paths, a hash of the command, sizes and costs.
 */

export const JEV_TOOL_NAMES = [
  "ask_jev_file_bool",
  "ask_jev_file_choice",
  "ask_jev_file_score",
  "ask_jev_files",
  "pick_first_file",
  "ask_jev",
  "ask_jev_diff_risk",
] as const;

export type JevToolName = (typeof JEV_TOOL_NAMES)[number];

/**
 * `answered`: every JEV call answered. `partial`: some did (`ask_jev_files`). `refused`: code
 * declined before any JEV call (a bad path, the gate, a size). `unavailable` and `failed`: the
 * service's own outcome, so the agent fell back to Read or Bash.
 */
export type JevToolUseOutcome = "answered" | "partial" | "refused" | "unavailable" | "failed";

export interface JevToolUseRecord {
  v: 1;
  at: string;
  agentId: string;
  /** The `paseo.jev-tools` label. Only `on` agents have the tools, so every line says `on`. */
  arm: "on";
  tool: JevToolName;
  outcome: JevToolUseOutcome;
  /** The refusal, unavailable or failure reason in a few words; null when answered. */
  reason: string | null;
  jevCalls: number;
  jevAnswered: number;
  jevUsd: number;
  jevInputTokens: number;
  /** Characters of the tool result the agent received: what stays in its context. */
  resultChars: number;
  /**
   * What reading the same content would have cost the agent, in tokens (`estimateReadTokens`):
   * every file sent to JEV, plus a command's output. Zero when nothing was read.
   */
  readTokensAvoided: number;
  /**
   * The caller's context size when it called: the tokens the extra model step re-reads. Null when
   * the provider has not reported usage yet.
   */
  callerContextTokens: number | null;
  /** The caller's cwd, so the report can resolve a relative `cat` in its transcript. */
  cwd: string;
  /** Absolute paths whose content went to JEV, for the regret-read join. At most 120. */
  paths: string[];
  /** SHA-256 of `ask_jev`'s command, so the report can match a later Bash call without storing it. */
  commandSha256: string | null;
  /** `ask_jev_diff_risk` only. */
  diffRisk: { risk: number | null; needsFullReview: boolean; forcedBy: string[] } | null;
  elapsedMs: number;
}

/**
 * Tokens the agent would have spent reading `content` with Read: about 3.5 bytes a token for code
 * and prose, plus one token a line for Read's line-number prefix. An estimate, recorded the same
 * way for every call, so the arms compare like with like.
 */
export function estimateReadTokens(content: string): number {
  if (content.length === 0) return 0;
  const bytes = Buffer.byteLength(content, "utf8");
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) if (content.charCodeAt(i) === 10) lines += 1;
  return Math.ceil(bytes / READ_BYTES_PER_TOKEN) + lines;
}

const READ_BYTES_PER_TOKEN = 3.5;
const DEFAULT_MAX_BYTES = 4_000_000;
export const JEV_TOOL_USE_FILE = "tool-use.jsonl";
export const JEV_TOOL_USE_ROTATED_FILE = "tool-use.1.jsonl";

export interface JevToolUseLogOptions {
  /** `$PASEO_HOME/jev`, shared with the ledger and the audit. */
  dir: string;
  logger: Logger;
  platform?: NodeJS.Platform;
  maxBytes?: number;
}

/** Appends are queued and written serially, off the tool call's path. Never throws. */
export class JevToolUseLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly maxBytes: number;
  private writeChain: Promise<void> = Promise.resolve();
  private currentSize: number | null = null;

  constructor(options: JevToolUseLogOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.platform = options.platform ?? process.platform;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get filePath(): string {
    return path.join(this.dir, JEV_TOOL_USE_FILE);
  }

  append(record: JevToolUseRecord): void {
    this.logger.info({ ...record }, "jev-tool-use");
    this.writeChain = this.writeChain.then(() =>
      this.appendOne(record).catch((error) => {
        this.logger.warn({ err: error }, "jev: tool-use append failed");
      }),
    );
  }

  /** Resolves once every append queued so far has landed. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async appendOne(record: JevToolUseRecord): Promise<void> {
    const text = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    const posix = this.platform !== "win32";
    await fs.mkdir(this.dir, posix ? { recursive: true, mode: 0o700 } : { recursive: true });
    if (this.currentSize === null) {
      const stat = await fs.stat(this.filePath).catch(() => null);
      this.currentSize = stat?.size ?? 0;
    }
    if (this.currentSize + bytes > this.maxBytes) {
      await fs
        .rename(this.filePath, path.join(this.dir, JEV_TOOL_USE_ROTATED_FILE))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      this.currentSize = 0;
    }
    await fs.appendFile(this.filePath, text, posix ? { mode: 0o600 } : undefined);
    this.currentSize += bytes;
  }
}
