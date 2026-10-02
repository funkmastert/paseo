import type { JevLane } from "./contract.js";

export interface JevLaneLimits {
  control: number;
  agentTools: number;
  interactive: number;
  reads: number;
  perGroup: number;
  requestsPerSecond: number;
}

type SlotResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "saturated" | "aborted" };
type TokenResult = { ok: true } | { ok: false; reason: "saturated" | "aborted" };

/** What `tryPass` lets through: a call while closed, the one probe while half-open, or nothing. */
export type JevCircuitPass = "pass" | "probe" | "refused";

/**
 * Per-lane breaker. Five consecutive failures open it for `openMs`; then one probe is let through.
 * The probe's success closes it; its failure reopens it for twice the last window, up to
 * `maxOpenMs`. A probe that never reports is presumed lost once the window it would have reopened
 * for has passed, so a lane is never shut past its backoff without a new probe.
 */
export class JevCircuit {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly maxOpenMs: number;
  private failures = 0;
  private openedAt: number | null = null;
  private windowMs: number;
  private failedProbes = 0;
  private probeStartedAt: number | null = null;

  constructor(options?: { failureThreshold?: number; openMs?: number; maxOpenMs?: number }) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.openMs = options?.openMs ?? 60_000;
    this.maxOpenMs = Math.max(this.openMs, options?.maxOpenMs ?? 10 * 60_000);
    this.windowMs = this.openMs;
  }

  state(now: number): "closed" | "open" | "half-open" {
    if (this.openedAt === null) return "closed";
    return now - this.openedAt >= this.windowMs ? "half-open" : "open";
  }

  tryPass(now: number): JevCircuitPass {
    const currentState = this.state(now);
    if (currentState === "closed") return "pass";
    if (currentState === "open") return "refused";
    if (this.probeStartedAt !== null && now - this.probeStartedAt < this.windowMs) return "refused";
    this.probeStartedAt = now;
    return "probe";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.windowMs = this.openMs;
    this.failedProbes = 0;
    this.probeStartedAt = null;
  }

  /** `probe`: the failure is the probe's own, which `tryPass` answered `"probe"` for. */
  recordFailure(now: number, options?: { probe?: boolean }): void {
    if (options?.probe) {
      this.probeStartedAt = null;
      this.failedProbes += 1;
      this.windowMs = Math.min(this.maxOpenMs, this.openMs * 2 ** (this.failedProbes - 1));
      this.openedAt = now;
      return;
    }
    // A late failure from a call let through before the circuit opened adds nothing: the
    // circuit's window is the probe's to set.
    if (this.openedAt !== null) return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = now;
      this.windowMs = this.openMs;
    }
  }
}

interface SlotWaiter {
  settle: (result: TokenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/** Per-lane or per-group concurrency. Capacity is read fresh on every `acquire` call. */
class Semaphore {
  private inUse = 0;
  private capacity = 0;
  private waiters: SlotWaiter[] = [];

  get count(): number {
    return this.inUse;
  }

  acquire(
    capacity: number,
    deadlineAt: number,
    now: () => number,
    signal?: AbortSignal,
  ): Promise<TokenResult> {
    this.capacity = capacity;
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
    if (now() >= deadlineAt) return Promise.resolve({ ok: false, reason: "saturated" });
    if (this.inUse < this.capacity && this.waiters.length === 0) {
      this.inUse += 1;
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve) => {
      const waiter = {} as SlotWaiter;
      waiter.settle = (result) => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
        // Reached from the timer, the abort listener, and release()'s drain, but the clearTimeout/
        // removeEventListener above make exactly one of those the winner; this never double-resolves.
        // eslint-disable-next-line promise/no-multiple-resolved
        resolve(result);
      };
      waiter.timer = setTimeout(
        () => waiter.settle({ ok: false, reason: "saturated" }),
        Math.max(0, deadlineAt - now()),
      );
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => waiter.settle({ ok: false, reason: "aborted" });
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    if (this.inUse > 0) this.inUse -= 1;
    while (this.inUse < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      this.inUse += 1;
      waiter.settle({ ok: true });
    }
  }
}

interface RateWaiter {
  settle: (result: TokenResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/**
 * Daemon-wide token bucket. `control` and `interactive` waiters are always served before
 * `agentTools` ones: a person waiting on an answer does not queue behind agents' tool calls.
 * `reads` waiters get a token only when no other lane is waiting: a shadow read check is never
 * urgent, and a live one gives up at its own deadline and lets the read through.
 */
class RateLimiter {
  private configured = false;
  private ratePerSecond = 0;
  private capacity = 0;
  private tokens = 0;
  private lastRefillAt: number;
  private controlQueue: RateWaiter[] = [];
  private toolQueue: RateWaiter[] = [];
  private readsQueue: RateWaiter[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number) {
    this.lastRefillAt = now();
  }

  take(
    lane: JevLane,
    deadlineAt: number,
    limits: JevLaneLimits,
    signal?: AbortSignal,
  ): Promise<TokenResult> {
    this.configure(limits);
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
    if (this.now() >= deadlineAt) return Promise.resolve({ ok: false, reason: "saturated" });

    return new Promise((resolve) => {
      const queue = this.queueFor(lane);
      const waiter = {} as RateWaiter;
      waiter.settle = (result) => {
        this.removeWaiter(queue, waiter);
        clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
        // Reached from the timer, the abort listener, and the pump's drain, but the clearTimeout/
        // removeEventListener above make exactly one of those the winner; this never double-resolves.
        // eslint-disable-next-line promise/no-multiple-resolved
        resolve(result);
      };
      waiter.timer = setTimeout(
        () => waiter.settle({ ok: false, reason: "saturated" }),
        Math.max(0, deadlineAt - this.now()),
      );
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => waiter.settle({ ok: false, reason: "aborted" });
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      queue.push(waiter);
      this.pump();
    });
  }

  private queueFor(lane: JevLane): RateWaiter[] {
    switch (lane) {
      case "agentTools":
        return this.toolQueue;
      case "reads":
        return this.readsQueue;
      case "control":
      case "interactive":
        return this.controlQueue;
    }
  }

  /** The next queue to serve, in priority order, or null when nothing waits. */
  private nextQueue(): RateWaiter[] | null {
    if (this.controlQueue.length > 0) return this.controlQueue;
    if (this.toolQueue.length > 0) return this.toolQueue;
    if (this.readsQueue.length > 0) return this.readsQueue;
    return null;
  }

  private removeWaiter(queue: RateWaiter[], waiter: RateWaiter): void {
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
  }

  private configure(limits: JevLaneLimits): void {
    const rate = Math.min(15, Math.max(0, limits.requestsPerSecond));
    if (!this.configured) {
      this.ratePerSecond = rate;
      this.capacity = rate;
      this.tokens = rate;
      this.lastRefillAt = this.now();
      this.configured = true;
      return;
    }
    if (rate === this.ratePerSecond) return;
    this.refill();
    this.ratePerSecond = rate;
    this.capacity = rate;
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  private refill(): void {
    const now = this.now();
    if (this.ratePerSecond > 0) {
      const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
    }
    this.lastRefillAt = now;
  }

  private pump(): void {
    this.refill();
    while (this.tokens >= 1) {
      const queue = this.nextQueue();
      if (!queue) break;
      const waiter = queue.shift();
      if (!waiter) break;
      this.tokens -= 1;
      waiter.settle({ ok: true });
    }
    this.rescheduleTimer();
  }

  private rescheduleTimer(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (!this.nextQueue()) return;
    if (this.ratePerSecond <= 0) return;
    const deficit = Math.max(0, 1 - this.tokens);
    const waitMs = (deficit / this.ratePerSecond) * 1000;
    this.pumpTimer = setTimeout(() => this.pump(), waitMs);
    this.pumpTimer.unref?.();
  }
}

export class JevLanes {
  readonly circuits: Record<JevLane, JevCircuit>;
  private readonly now: () => number;
  private readonly laneSemaphores: Record<JevLane, Semaphore>;
  private readonly groupSemaphores = new Map<string, Semaphore>();
  private readonly rateLimiter: RateLimiter;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
    this.circuits = {
      control: new JevCircuit(),
      agentTools: new JevCircuit(),
      interactive: new JevCircuit(),
      reads: new JevCircuit(),
    };
    this.laneSemaphores = {
      control: new Semaphore(),
      agentTools: new Semaphore(),
      interactive: new Semaphore(),
      reads: new Semaphore(),
    };
    this.rateLimiter = new RateLimiter(this.now);
  }

  /** Waits for a lane slot (and, for agentTools with `group`, a per-group slot) until `deadlineAt`. */
  async acquireSlot(
    lane: JevLane,
    options: { deadlineAt: number; group?: string; limits: JevLaneLimits; signal?: AbortSignal },
  ): Promise<SlotResult> {
    // A request queued on its per-group cap holds no lane slot, so a saturated group never
    // starves other groups of the lane's remaining capacity.
    if (lane === "agentTools" && options.group !== undefined) {
      const group = options.group;
      const groupSemaphore = this.groupSemaphoreFor(group);
      const groupResult = await groupSemaphore.acquire(
        options.limits.perGroup,
        options.deadlineAt,
        this.now,
        options.signal,
      );
      if (!groupResult.ok) {
        this.cleanupGroup(group);
        return groupResult;
      }
      const laneResult = await this.laneSemaphores[lane].acquire(
        options.limits.agentTools,
        options.deadlineAt,
        this.now,
        options.signal,
      );
      if (!laneResult.ok) {
        groupSemaphore.release();
        this.cleanupGroup(group);
        return laneResult;
      }
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          this.laneSemaphores[lane].release();
          groupSemaphore.release();
          this.cleanupGroup(group);
        },
      };
    }

    const laneResult = await this.laneSemaphores[lane].acquire(
      options.limits[lane],
      options.deadlineAt,
      this.now,
      options.signal,
    );
    if (!laneResult.ok) return laneResult;

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.laneSemaphores[lane].release();
      },
    };
  }

  /**
   * Daemon-wide token bucket at `limits.requestsPerSecond` (at most 15). `control` and
   * `interactive` are served first.
   */
  takeRateToken(
    lane: JevLane,
    options: { deadlineAt: number; limits: JevLaneLimits; signal?: AbortSignal },
  ): Promise<TokenResult> {
    return this.rateLimiter.take(lane, options.deadlineAt, options.limits, options.signal);
  }

  inFlight(lane: JevLane): number {
    return this.laneSemaphores[lane].count;
  }

  private groupSemaphoreFor(group: string): Semaphore {
    let semaphore = this.groupSemaphores.get(group);
    if (!semaphore) {
      semaphore = new Semaphore();
      this.groupSemaphores.set(group, semaphore);
    }
    return semaphore;
  }

  private cleanupGroup(group: string): void {
    const semaphore = this.groupSemaphores.get(group);
    if (semaphore && semaphore.count === 0) this.groupSemaphores.delete(group);
  }
}
