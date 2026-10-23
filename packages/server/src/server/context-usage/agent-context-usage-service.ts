import type { Logger } from "pino";
import type { AgentContextUsage } from "@getpaseo/protocol/context-usage/rpc-schemas";
import type { AgentLifecycleStatus } from "../agent/agent-manager.js";
import type { AgentSession } from "../agent/agent-sdk-types.js";

export type ContextUsageLifecycle = AgentLifecycleStatus;

export interface ContextUsageAgentView {
  lifecycle: ContextUsageLifecycle;
  session: Pick<AgentSession, "getContextUsage"> | null;
}

/** The slice of the agent manager this service reads. */
export interface ContextUsageAgentPort {
  getAgent(agentId: string): ContextUsageAgentView | null;
  subscribe(listener: (agentId: string, lifecycle: ContextUsageLifecycle) => void): () => void;
}

export type ContextUsageReadStatus = "captured" | "cached" | "pending" | "unsupported" | "error";

export interface ContextUsageReadResult {
  status: ContextUsageReadStatus;
  usage: AgentContextUsage | null;
  error: string | null;
}

type Schedule = (fn: () => void, delayMs: number) => () => void;

export interface AgentContextUsageServiceOptions {
  agents: ContextUsageAgentPort;
  logger: Logger;
  now?: () => number;
  schedule?: Schedule;
}

/**
 * Each capture costs the CLI a handful of free count_tokens calls, and when count_tokens fails the
 * CLI falls back to one-token /v1/messages calls on the session's own model, which bill. So
 * capture only what someone is looking at, no more than once per interval per agent, one at a
 * time. See docs/context-usage.md.
 */
const MIN_CAPTURE_INTERVAL_MS = 30_000;
/** How long a read keeps an agent refreshing at turn ends — about as long as a popover stays up. */
const WATCH_TTL_MS = 10 * 60_000;
/** Let the turn's own bookkeeping settle before asking. */
const TURN_END_DELAY_MS = 2_000;
/** Memory files and skills can change on disk between turns; an idle cache this old is re-read. */
const IDLE_MAX_AGE_MS = 5 * 60_000;
const CAPTURE_TIMEOUT_MS = 30_000;

interface AgentEntry {
  cached: AgentContextUsage | null;
  capturedAtMs: number | null;
  /** A turn has run (or is running) since the cached capture. */
  dirty: boolean;
  watchedUntilMs: number;
  lifecycle: ContextUsageLifecycle | null;
  inFlight: Promise<ContextUsageReadResult> | null;
  cancelTimer: (() => void) | null;
}

function isMidTurn(lifecycle: ContextUsageLifecycle): boolean {
  return lifecycle === "running" || lifecycle === "initializing";
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * The daemon-wide cache behind `agent.context_usage.read`. It never asks an agent mid-turn: a
 * running agent gets its last capture, and an agent someone is watching is captured again shortly
 * after each turn ends.
 */
export class AgentContextUsageService {
  private readonly agents: ContextUsageAgentPort;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly entries = new Map<string, AgentEntry>();
  private captureChain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(options: AgentContextUsageServiceOptions) {
    this.agents = options.agents;
    this.logger = options.logger.child({ module: "agent-context-usage" });
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agents.subscribe((agentId, lifecycle) =>
      this.handleLifecycle(agentId, lifecycle),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const entry of this.entries.values()) entry.cancelTimer?.();
    this.entries.clear();
  }

  async read(agentId: string): Promise<ContextUsageReadResult> {
    const agent = this.agents.getAgent(agentId);
    if (!agent) {
      this.entries.delete(agentId);
      return { status: "error", usage: null, error: `Agent ${agentId} not found` };
    }
    const entry = this.entryFor(agentId);
    entry.watchedUntilMs = this.now() + WATCH_TTL_MS;
    entry.lifecycle = agent.lifecycle;
    if (!agent.session) {
      return entry.cached
        ? { status: "cached", usage: entry.cached, error: null }
        : { status: "error", usage: null, error: `Agent ${agentId} has no live session` };
    }
    if (!agent.session.getContextUsage) {
      return { status: "unsupported", usage: null, error: null };
    }
    if (isMidTurn(agent.lifecycle)) {
      entry.dirty = true;
      return entry.cached
        ? { status: "cached", usage: entry.cached, error: null }
        : { status: "pending", usage: null, error: null };
    }
    if (entry.inFlight) return entry.inFlight;
    if (entry.cached && !this.shouldRecapture(entry)) {
      return { status: "cached", usage: entry.cached, error: null };
    }
    return this.capture(agentId, entry, { allowStart: true });
  }

  private shouldRecapture(entry: AgentEntry): boolean {
    const age = entry.capturedAtMs === null ? Infinity : this.now() - entry.capturedAtMs;
    if (age < MIN_CAPTURE_INTERVAL_MS) return false;
    return entry.dirty || age >= IDLE_MAX_AGE_MS;
  }

  private entryFor(agentId: string): AgentEntry {
    let entry = this.entries.get(agentId);
    if (!entry) {
      entry = {
        cached: null,
        capturedAtMs: null,
        dirty: true,
        watchedUntilMs: 0,
        lifecycle: null,
        inFlight: null,
        cancelTimer: null,
      };
      this.entries.set(agentId, entry);
    }
    return entry;
  }

  private handleLifecycle(agentId: string, lifecycle: ContextUsageLifecycle): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const previous = entry.lifecycle;
    entry.lifecycle = lifecycle;
    if (lifecycle === "closed") {
      entry.cancelTimer?.();
      this.entries.delete(agentId);
      return;
    }
    if (isMidTurn(lifecycle)) {
      entry.dirty = true;
      entry.cancelTimer?.();
      entry.cancelTimer = null;
      return;
    }
    const turnEnded = previous !== null && isMidTurn(previous);
    if (turnEnded && entry.watchedUntilMs > this.now()) {
      this.scheduleTurnEndCapture(agentId, entry, TURN_END_DELAY_MS);
    }
  }

  private scheduleTurnEndCapture(agentId: string, entry: AgentEntry, delayMs: number): void {
    entry.cancelTimer?.();
    entry.cancelTimer = this.schedule(() => {
      entry.cancelTimer = null;
      this.runTurnEndCapture(agentId, entry);
    }, delayMs);
  }

  private runTurnEndCapture(agentId: string, entry: AgentEntry): void {
    if (this.entries.get(agentId) !== entry || !entry.dirty || entry.inFlight) return;
    const agent = this.agents.getAgent(agentId);
    if (!agent?.session?.getContextUsage || isMidTurn(agent.lifecycle)) return;
    const age = entry.capturedAtMs === null ? Infinity : this.now() - entry.capturedAtMs;
    if (age < MIN_CAPTURE_INTERVAL_MS) {
      this.scheduleTurnEndCapture(agentId, entry, MIN_CAPTURE_INTERVAL_MS - age);
      return;
    }
    // Never start a runtime in the background: only an agent whose process is still up is asked.
    void this.capture(agentId, entry, { allowStart: false });
  }

  private capture(
    agentId: string,
    entry: AgentEntry,
    options: { allowStart: boolean },
  ): Promise<ContextUsageReadResult> {
    const run = async (): Promise<ContextUsageReadResult> => {
      const agent = this.agents.getAgent(agentId);
      const getContextUsage = agent?.session?.getContextUsage;
      // The agent may have started a turn while this capture waited its turn in the queue.
      if (!agent || !getContextUsage || isMidTurn(agent.lifecycle)) {
        return this.cachedOrPending(entry);
      }
      entry.dirty = false;
      try {
        const usage = await withTimeout(
          getContextUsage.call(agent.session, options),
          CAPTURE_TIMEOUT_MS,
        );
        if (!usage) return this.cachedOrPending(entry);
        entry.cached = usage;
        entry.capturedAtMs = this.now();
        return { status: "captured", usage, error: null };
      } catch (error) {
        entry.dirty = true;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ err: error, agentId }, "Context usage capture failed");
        return { status: "error", usage: entry.cached, error: message };
      }
    };
    const result = this.captureChain.then(run, run);
    this.captureChain = result.catch(() => undefined);
    entry.inFlight = result;
    void result.finally(() => {
      if (entry.inFlight === result) entry.inFlight = null;
    });
    return result;
  }

  private cachedOrPending(entry: AgentEntry): ContextUsageReadResult {
    return entry.cached
      ? { status: "cached", usage: entry.cached, error: null }
      : { status: "pending", usage: null, error: null };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Context usage capture timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
