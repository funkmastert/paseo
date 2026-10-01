import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { JevSavingsSink } from "./contract.js";
import { JevSavingsLedger } from "./savings.js";
import { estimateContextTokens, type JevSavingsFacts } from "./savings-formulas.js";
import { pendingSavingsFor } from "./savings-hooks.js";

/**
 * Adapters for features whose code is still on its own branch (docs/jev.md, "Savings", "Hooking in
 * the features already built"): each tails the feature's own measurement file and reports what it
 * reads, so the ledger counts them before they merge. Lines written before the daemon started are
 * skipped: the JEV ledger no longer holds their calls. When a feature merges with its own
 * `recordSavings()` call, its adapter is removed in the same change.
 */

const POLL_INTERVAL_MS = 15_000;
/** Feature 4's validation window: a read of a path sent to JEV within this is a regret. */
const TOOL_REGRET_WINDOW_MS = 60 * 60_000;
/** The stall track's floors for `blocked_missing_info` and `waiting_on_human` (`STALL_JUDGMENT_FLOORS`). */
const PERSON_FIRST_FLOOR = 0.75;
const PERSON_FIRST_ACTIVITIES = new Set(["blocked_missing_info", "waiting_on_human"]);
const STALL_FLOORS: Readonly<Record<string, number>> = {
  progressing: 0.85,
  looping: 0.75,
  blocked_missing_info: 0.75,
  waiting_on_human: 0.75,
};

type Line = Record<string, unknown>;

/**
 * Follows one JSONL file from its end, across one rotation to `rotatedPath`. A new inode at the
 * path is a rotation only when the rotated file is the one being followed; otherwise the file was
 * rewritten in place (a boot prune), its lines are old, and the tail restarts at its end. Where the
 * filesystem reports no inode, a shrink is read as a rotation.
 */
export class JsonlTail {
  private offset: number | null = null;
  private ino = 0;
  private remainder = Buffer.alloc(0);

  constructor(
    private readonly filePath: string,
    private readonly rotatedPath: string,
    private readonly onLine: (line: Line) => void,
  ) {}

  /** Starts at the file's current end. */
  async start(): Promise<void> {
    const stat = await fs.stat(this.filePath).catch(() => null);
    this.offset = stat?.size ?? 0;
    this.ino = stat?.ino ?? 0;
  }

  async poll(): Promise<void> {
    if (this.offset === null) await this.start();
    const stat = await fs.stat(this.filePath).catch(() => null);
    const size = stat?.size ?? 0;
    const ino = stat?.ino ?? 0;
    const offset = this.offset ?? 0;
    const replaced = ino !== 0 && this.ino !== 0 ? ino !== this.ino : size < offset;
    if (replaced) {
      const rotated = await fs.stat(this.rotatedPath).catch(() => null);
      const wasRotated = this.ino === 0 || ino === 0 || rotated?.ino === this.ino;
      // The rest of the old file is the rotated one's tail, and the new file is all new.
      if (wasRotated) await this.readFrom(this.rotatedPath, offset);
      this.remainder = Buffer.alloc(0);
      this.offset = wasRotated ? 0 : size;
      this.ino = ino;
    } else if (this.ino === 0) {
      this.ino = ino;
    }
    if (size > (this.offset ?? 0))
      this.offset = await this.readFrom(this.filePath, this.offset ?? 0);
  }

  private async readFrom(filePath: string, from: number): Promise<number> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(filePath, "r");
      const { size } = await handle.stat();
      if (size <= from) return from;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const text = Buffer.concat([this.remainder, buffer]);
      const lastNewline = text.lastIndexOf(10);
      this.remainder = lastNewline < 0 ? text : text.subarray(lastNewline + 1);
      if (lastNewline >= 0) {
        for (const raw of text.subarray(0, lastNewline).toString("utf8").split("\n")) {
          const line = parse(raw);
          if (line) this.onLine(line);
        }
      }
      return size;
    } catch {
      return from;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function parse(raw: string): Line | null {
  if (raw.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Line)
      : null;
  } catch {
    return null;
  }
}

function str(line: Line, key: string): string | null {
  const value = line[key];
  return typeof value === "string" ? value : null;
}

function num(line: Line, key: string): number | null {
  const value = line[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Features 4-6: one tool call, as `tool-use.jsonl` records it (`JevToolUseRecord`). Mode, outcome
 * and cost come from the line, which sums every JEV call the tool made. `T_avoided` is the line's
 * `readTokensAvoided` as it is: the tools track counts it at 2.35 characters a token, with Read's
 * 7-character line prefix (`estimateReadTokens`), so converting it again would inflate it. A path
 * sent to JEV is watched for a regret read. `callId` is the tool call's first JEV call once the
 * tools code passes it; the adapter, which has none, builds one from the agent, time and tool.
 * `record` is `object` so the tools code can pass its typed `JevToolUseRecord` as it is.
 */
export function recordToolUseSavings(
  savings: JevSavingsSink | null | undefined,
  record: object,
  context: { callId?: string | null; model: string | null },
): string {
  if (!(savings instanceof JevSavingsLedger)) return "";
  const line = record as Line;
  const agentId = str(line, "agentId");
  const tool = str(line, "tool");
  const at = str(line, "at");
  const outcome = str(line, "outcome");
  if (line["v"] !== 1 || !agentId || !tool || !at || !outcome || outcome === "refused") return "";
  if (outcome === "unavailable") {
    savings.countNotAsked("agentTools", notAskedReason(str(line, "reason")));
    return "";
  }
  if ((num(line, "jevCalls") ?? 0) === 0) return "";
  const answered = outcome === "answered" || outcome === "partial";
  const paths = Array.isArray(line["paths"])
    ? line["paths"].filter((value): value is string => typeof value === "string")
    : [];
  const avoided = num(line, "readTokensAvoided") ?? 0;
  const id = savings.recordObserved(
    {
      feature: "agentTools",
      callSite: `tools.${tool}`,
      callId: context.callId ?? `tool-use:${agentId}:${at}:${tool}`,
      agentId,
      involvement: tool,
      decision: { did: outcome, wouldBe: null, changed: answered },
      facts: {
        tool,
        answered,
        tAvoided: avoided,
        tAvoidedSource: "readTokensAvoided, the tools track's count at 2.35 characters a token",
        tResult: estimateContextTokens(num(line, "resultChars") ?? 0),
        callerContextTokens: num(line, "callerContextTokens"),
        model: context.model,
        jevCalls: num(line, "jevCalls"),
        commandSha256: str(line, "commandSha256"),
        ...regretWatchFacts(answered ? paths : []),
      },
    },
    {
      mode: "live",
      outcome: answered ? "answered" : "failed",
      at,
      jevCostUsd: num(line, "jevUsd"),
    },
  );
  if (answered && id) savings.watchReads(id, agentId, paths, TOOL_REGRET_WINDOW_MS);
  return id;
}

/** The regret window, kept on the record so a restart rebuilds it; `none` with no path to watch. */
function regretWatchFacts(paths: readonly string[]): JevSavingsFacts {
  return paths.length === 0
    ? { regretWatch: "none" }
    : { regretPaths: JSON.stringify(paths), regretWindowMs: TOOL_REGRET_WINDOW_MS };
}

function notAskedReason(reason: string | null): "excluded" | "inactive" {
  return reason?.includes("excluded") ? "excluded" : "inactive";
}

/** The `tool-use.jsonl` adapter, until the tools code calls `recordToolUseSavings` itself. */
export function createToolUseSavingsAdapter(options: {
  savings: JevSavingsSink;
  readAgentModel: (agentId: string) => string | null;
}): (line: Line) => void {
  return (line) => {
    try {
      const agentId = str(line, "agentId");
      recordToolUseSavings(options.savings, line, {
        model: agentId ? options.readAgentModel(agentId) : null,
      });
    } catch {
      // An adapter never breaks the tail.
    }
  };
}

/**
 * Feature 10, from `stall-judgments.jsonl`. A `judgment` with a call records (pending for a
 * person-first label, which the remediation hook settles from the episode's agent); an
 * `episode-closed` settles a stall that never reached rung 2 and validates a `progressing` hold.
 */
export function createStallJudgmentSavingsAdapter(options: {
  savings: JevSavingsSink;
}): (line: Line) => void {
  const { savings } = options;
  const byEpisode = new Map<string, string>();
  return (line) => {
    try {
      if (line["type"] === "judgment") recordJudgment(savings, byEpisode, line);
      else if (line["type"] === "episode-closed") closeEpisode(savings, byEpisode, line);
    } catch {
      // An adapter never breaks the tail.
    }
  };
}

function recordJudgment(savings: JevSavingsSink, byEpisode: Map<string, string>, line: Line): void {
  const callId = str(line, "callId");
  const agentId = str(line, "agentId");
  const episodeKey = str(line, "episodeKey");
  if (!callId || !agentId || !episodeKey) return;
  const { activity, confidence, atFloor, personFirst } = readStallJudgment(line["judgment"]);
  const branch = str(line, "branch") ?? "candidate";
  const id = savings.record({
    feature: "stallJudgment",
    callSite: `stalls.${branch}`,
    callId,
    agentId,
    involvement:
      branch === "candidate"
        ? "What is this stalled agent doing?"
        : "Is this running agent looping?",
    decision: {
      did: str(line, "action") ?? "",
      wouldBe: str(line, "wouldAction"),
      changed: isLine(line["judgment"]) && line["judgment"]["applied"] === true && atFloor,
    },
    facts: {
      activity,
      confidence,
      personFirst,
      episodeKey,
      branch,
      quietMinutes: num(line, "quietMinutes"),
    },
    pending: personFirst,
  });
  if (id && branch === "candidate") byEpisode.set(episodeKey, id);
}

function isLine(value: unknown): value is Line {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The judgment's label against the stall track's floors; a person-first label at its floor. */
function readStallJudgment(value: unknown): {
  activity: string | null;
  confidence: number | null;
  atFloor: boolean;
  personFirst: boolean;
} {
  const judgment = isLine(value) ? value : null;
  const activity = judgment ? str(judgment, "activity") : null;
  const confidence = judgment ? num(judgment, "confidence") : null;
  if (activity === null || confidence === null) {
    return { activity, confidence, atFloor: false, personFirst: false };
  }
  const atFloor = confidence >= (STALL_FLOORS[activity] ?? 1);
  const personFirst =
    atFloor && PERSON_FIRST_ACTIVITIES.has(activity) && confidence >= PERSON_FIRST_FLOOR;
  return { activity, confidence, atFloor, personFirst };
}

function closeEpisode(savings: JevSavingsSink, byEpisode: Map<string, string>, line: Line): void {
  const episodeKey = str(line, "episodeKey");
  if (!episodeKey) return;
  const id =
    byEpisode.get(episodeKey) ??
    pendingSavingsFor(savings, "stallJudgment").find(
      (record) => record.facts["episodeKey"] === episodeKey,
    )?.id;
  byEpisode.delete(episodeKey);
  if (!id) return;
  if (line["pastRecheck"] === false) savings.settle(id, { reachedRung2: false });
  if (line["held"] === true) {
    const cleared = line["closedDuringHold"] === true;
    savings.validate(id, {
      outcome: cleared ? "held" : "contradicted",
      signal: cleared ? "moved-during-hold" : "still-stalled-after-hold",
      afterMinutes: num(line, "minutesAfterAct"),
    });
  }
}

/**
 * Tails both files and polls them every 15 seconds. `stop` polls a last time, so the lines of the
 * last interval count; the ledger flushes them after.
 */
export function startSavingsAdapters(options: {
  jevDir: string;
  savings: JevSavingsSink;
  readAgentModel: (agentId: string) => string | null;
  logger: Logger;
}): { stop(): Promise<void>; poll(): Promise<void> } {
  const tails = [
    new JsonlTail(
      path.join(options.jevDir, "tool-use.jsonl"),
      path.join(options.jevDir, "tool-use.1.jsonl"),
      createToolUseSavingsAdapter(options),
    ),
    new JsonlTail(
      path.join(options.jevDir, "stall-judgments.jsonl"),
      path.join(options.jevDir, "stall-judgments.1.jsonl"),
      createStallJudgmentSavingsAdapter(options),
    ),
  ];
  let polling: Promise<void> = Promise.all(tails.map((tail) => tail.start())).then(() => undefined);
  const poll = async () => {
    polling = polling.then(() =>
      Promise.all(tails.map((tail) => tail.poll())).then(() => undefined),
    );
    await polling.catch((error: unknown) =>
      options.logger.warn({ err: error }, "jev savings: adapter poll failed"),
    );
  };
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await poll();
    },
    poll,
  };
}
