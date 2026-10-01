import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { JevSavingsValidation } from "../contract.js";

/**
 * Did the agent use a file JEV said it did not need (docs/jev.md, "Did the agent use it")? For
 * each `not_needed` verdict a window stays open for the rest of the read's turn and the next two,
 * at most 60 minutes, and closes on the first sign of use:
 *
 * - `edited`: an Edit, Write, MultiEdit or NotebookEdit on the path;
 * - `reread`: a `Read` or a Bash read of the path, any range; in live, the retry after a deny;
 * - `quoted`: a line of 40 or more characters from the range in a later assistant message or
 *   tool input;
 * - `redirected`, live only: an `ask_jev_file_*` call on the path. The deny worked as meant.
 *
 * With none seen the verdict `held`. A use is a `false-skip` in shadow and a `regret` in live.
 */

export const READ_CHECK_WINDOW_MS = 60 * 60_000;
/** The read's own turn and the next two. */
export const READ_CHECK_WINDOW_TURNS = 3;
export const READ_CHECK_QUOTE_MIN_CHARS = 40;
export const READ_CHECK_MAX_QUOTE_LINES = 2000;
/** A daemon-wide ceiling, so a burst of verdicts cannot hold unbounded line sets. */
const MAX_OPEN_WINDOWS = 500;

export type ReadCheckSignal = "edited" | "reread" | "quoted" | "redirected";

export interface ReadCheckTimelineRow {
  seq: number;
  timestamp: string;
  turnId?: string;
  item: AgentTimelineItem;
}

export interface ReadCheckWindowInput {
  savingsId: string;
  agentId: string;
  /** Real path. */
  path: string;
  /** How the agent's tools name the path, e.g. relative to its cwd. Matched in tool inputs. */
  spellings: string[];
  mode: "shadow" | "live";
  openedAt: number;
  /** The text the read loaded (or would have), for the quote check. */
  rangeText: string;
  /** The read's timeline row, when it was found: later rows are scanned from here. */
  after: { epoch: string; seq: number } | null;
  /** The turn the read happened in, when known. */
  turnId: string | null;
}

interface OpenWindow extends Omit<ReadCheckWindowInput, "rangeText"> {
  quoteHashes: Set<string>;
  turns: string[];
}

export interface ReadCheckWindowClose {
  savingsId: string;
  agentId: string;
  path: string;
  mode: "shadow" | "live";
  validation: JevSavingsValidation;
}

function hashLine(line: string): string {
  return createHash("sha1").update(line).digest("base64");
}

/** The range's lines worth matching as quotes: trimmed, 40 characters or more, at most 2,000. */
export function quoteHashesOf(text: string): Set<string> {
  const hashes = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < READ_CHECK_QUOTE_MIN_CHARS) continue;
    hashes.add(hashLine(line));
    if (hashes.size >= READ_CHECK_MAX_QUOTE_LINES) break;
  }
  return hashes;
}

/** Text a later row put in front of the model or into a tool: where a quote would show. */
function rowTexts(item: AgentTimelineItem): string[] {
  if (item.type === "assistant_message") return [item.text];
  if (item.type !== "tool_call") return [];
  const detail = item.detail;
  switch (detail.type) {
    case "edit":
      return [detail.newString ?? "", detail.unifiedDiff ?? ""];
    case "write":
      return [detail.content ?? ""];
    case "shell":
      return [detail.command];
    case "unknown":
      return [JSON.stringify(detail.input ?? null)];
    default:
      return [];
  }
}

function quotes(item: AgentTimelineItem, hashes: Set<string>): boolean {
  if (hashes.size === 0) return false;
  for (const text of rowTexts(item)) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length >= READ_CHECK_QUOTE_MIN_CHARS && hashes.has(hashLine(line))) return true;
    }
  }
  return false;
}

function isAskJevFileCall(item: AgentTimelineItem, spellings: readonly string[]): boolean {
  if (item.type !== "tool_call" || !/ask_jev_files?(_|$)/.test(item.name)) return false;
  const text = JSON.stringify(item.detail);
  return spellings.some((spelling) => spelling.length > 0 && text.includes(spelling));
}

export interface ReadCheckValidationOptions {
  now: () => number;
  onClose: (close: ReadCheckWindowClose) => void;
}

export class ReadCheckValidation {
  private readonly windows = new Map<string, OpenWindow>();

  constructor(private readonly options: ReadCheckValidationOptions) {}

  get size(): number {
    return this.windows.size;
  }

  open(input: ReadCheckWindowInput): void {
    if (this.windows.size >= MAX_OPEN_WINDOWS) {
      // The oldest window closes as held: an upper bound, like every shadow held.
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.close(oldest, null, null);
    }
    const { rangeText, ...rest } = input;
    this.windows.set(input.savingsId, {
      ...rest,
      quoteHashes: quoteHashesOf(rangeText),
      turns: input.turnId ? [input.turnId] : [],
    });
  }

  /** Open windows for an agent, for the observer's scan of its later timeline rows. */
  openFor(
    agentId: string,
  ): Array<{ savingsId: string; after: { epoch: string; seq: number } | null; openedAt: number }> {
    return [...this.windows.values()]
      .filter((window) => window.agentId === agentId)
      .map((window) => ({
        savingsId: window.savingsId,
        after: window.after,
        openedAt: window.openedAt,
      }));
  }

  agentsWithOpenWindows(): string[] {
    return [...new Set([...this.windows.values()].map((window) => window.agentId))];
  }

  noteEdit(agentId: string, path: string, at: number): void {
    this.signalPath(agentId, path, "edited", at);
  }

  noteRead(agentId: string, path: string, at: number): void {
    this.signalPath(agentId, path, "reread", at);
  }

  /**
   * Later timeline rows for one window, oldest first. Counts turns, and closes on a quote or a
   * redirect, or as held once the window's third turn has ended.
   */
  scan(savingsId: string, epoch: string, rows: readonly ReadCheckTimelineRow[]): void {
    const window = this.windows.get(savingsId);
    if (!window) return;
    for (const row of rows) {
      // By position when the cursor is from this timeline; by time after a reset.
      const seen =
        window.after !== null && window.after.epoch === epoch
          ? row.seq <= window.after.seq
          : Date.parse(row.timestamp) <= window.openedAt;
      if (seen) continue;
      if (row.turnId && !window.turns.includes(row.turnId)) {
        if (window.turns.length >= READ_CHECK_WINDOW_TURNS) {
          this.close(savingsId, null, null);
          return;
        }
        window.turns.push(row.turnId);
      }
      const at = Date.parse(row.timestamp);
      if (window.mode === "live" && isAskJevFileCall(row.item, window.spellings)) {
        this.close(savingsId, "redirected", at);
        return;
      }
      if (quotes(row.item, window.quoteHashes)) {
        this.close(savingsId, "quoted", at);
        return;
      }
      window.after = { epoch, seq: row.seq };
    }
  }

  /** Closes every window past 60 minutes as held. */
  expire(now: number): void {
    for (const [savingsId, window] of this.windows) {
      if (now - window.openedAt >= READ_CHECK_WINDOW_MS) this.close(savingsId, null, null);
    }
  }

  private signalPath(agentId: string, path: string, signal: ReadCheckSignal, at: number): void {
    for (const [savingsId, window] of this.windows) {
      if (window.agentId === agentId && window.path === path && at >= window.openedAt) {
        this.close(savingsId, signal, at);
      }
    }
  }

  private close(savingsId: string, signal: ReadCheckSignal | null, at: number | null): void {
    const window = this.windows.get(savingsId);
    if (!window) return;
    this.windows.delete(savingsId);
    let outcome: JevSavingsValidation["outcome"] = "held";
    if (signal !== null && signal !== "redirected") {
      outcome = window.mode === "live" ? "regret" : "false-skip";
    }
    const afterMinutes =
      at === null ? null : Math.round(((at - window.openedAt) / 60_000) * 10) / 10;
    try {
      this.options.onClose({
        savingsId,
        agentId: window.agentId,
        path: window.path,
        mode: window.mode,
        validation: {
          outcome,
          signal,
          afterMinutes: afterMinutes === null ? null : Math.max(0, afterMinutes),
        },
      });
    } catch {
      // The record never affects the agent.
    }
  }
}
