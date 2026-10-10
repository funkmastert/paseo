import { describe, expect, test } from "vitest";
import type { AgentContextUsage } from "@getpaseo/protocol/context-usage/rpc-schemas";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentContextUsageService,
  type ContextUsageAgentPort,
  type ContextUsageAgentView,
  type ContextUsageLifecycle,
} from "./agent-context-usage-service.js";

function usageAt(capturedAt: string, totalTokens = 174085): AgentContextUsage {
  return {
    provider: "claude",
    model: "claude-opus-5-5[1m]",
    capturedAt,
    source: "session",
    totalTokens,
    maxTokens: 1000000,
    categories: [{ id: "messages", label: "Messages", tokens: totalTokens, kind: "used" }],
    memoryFiles: [],
  };
}

interface Capture {
  allowStart: boolean;
  lifecycleAtCall: ContextUsageLifecycle;
}

/** An agent whose session answers `/context` from a script, recording every capture. */
class FakeAgent {
  lifecycle: ContextUsageLifecycle = "idle";
  captures: Capture[] = [];
  answers: Array<AgentContextUsage | null | Error> = [];
  supportsContextUsage = true;
  hasSession = true;
  private pending: Array<() => void> = [];
  hold = false;

  view(): ContextUsageAgentView {
    if (!this.hasSession) return { lifecycle: this.lifecycle, session: null };
    if (!this.supportsContextUsage) return { lifecycle: this.lifecycle, session: {} };
    return {
      lifecycle: this.lifecycle,
      session: { getContextUsage: (options: { allowStart: boolean }) => this.answer(options) },
    };
  }

  release(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  private async answer(options: { allowStart: boolean }): Promise<AgentContextUsage | null> {
    this.captures.push({ allowStart: options.allowStart, lifecycleAtCall: this.lifecycle });
    if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve));
    const next =
      this.answers.length > 0 ? this.answers.shift() : usageAt(new Date(clock.now).toISOString());
    if (next instanceof Error) throw next;
    return next ?? null;
  }
}

const clock = { now: Date.parse("2026-09-24T12:00:00.000Z") };

class FakeScheduler {
  timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  schedule = (fn: () => void, delayMs: number) => {
    const timer = { at: clock.now + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  async advance(ms: number): Promise<void> {
    clock.now += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= clock.now);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
    await flush();
  }
  get pendingCount(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup() {
  clock.now = Date.parse("2026-09-24T12:00:00.000Z");
  const agents = new Map<string, FakeAgent>();
  let listener: ((agentId: string, lifecycle: ContextUsageLifecycle) => void) | null = null;
  const port: ContextUsageAgentPort = {
    getAgent: (agentId) => agents.get(agentId)?.view() ?? null,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const scheduler = new FakeScheduler();
  const service = new AgentContextUsageService({
    agents: port,
    logger: createTestLogger(),
    now: () => clock.now,
    schedule: scheduler.schedule,
  });
  service.start();
  function add(agentId: string): FakeAgent {
    const agent = new FakeAgent();
    agents.set(agentId, agent);
    return agent;
  }
  async function transition(agentId: string, lifecycle: ContextUsageLifecycle): Promise<void> {
    const agent = agents.get(agentId);
    if (agent) agent.lifecycle = lifecycle;
    listener?.(agentId, lifecycle);
    await flush();
  }
  return { service, scheduler, add, transition, agents };
}

describe("AgentContextUsageService.read", () => {
  test("captures an idle agent, starting its runtime if it has to", async () => {
    const { service, add } = setup();
    const agent = add("a1");

    const result = await service.read("a1");

    expect(result.status).toBe("captured");
    expect(result.usage?.totalTokens).toBe(174085);
    expect(agent.captures).toEqual([{ allowStart: true, lifecycleAtCall: "idle" }]);
  });

  test("never asks a running agent: pending with nothing cached", async () => {
    const { service, add } = setup();
    const agent = add("a1");
    agent.lifecycle = "running";

    const result = await service.read("a1");

    expect(result).toEqual({ status: "pending", usage: null, error: null });
    expect(agent.captures).toEqual([]);
  });

  test("serves the last capture to a running agent", async () => {
    const { service, add, transition } = setup();
    const agent = add("a1");
    await service.read("a1");
    await transition("a1", "running");

    const result = await service.read("a1");

    expect(result.status).toBe("cached");
    expect(result.usage?.capturedAt).toBe("2026-09-24T12:00:00.000Z");
    expect(agent.captures).toHaveLength(1);
  });

  test("an idle agent whose context has not changed is served from cache", async () => {
    const { service, add, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    await scheduler.advance(60_000);

    const result = await service.read("a1");

    expect(result.status).toBe("cached");
    expect(agent.captures).toHaveLength(1);
  });

  test("recaptures an idle agent whose context changed since the last capture", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    // Past the watch window, so no turn-end capture runs on its own.
    await scheduler.advance(11 * 60_000);
    await transition("a1", "running");
    await transition("a1", "idle");

    const result = await service.read("a1");

    expect(result.status).toBe("captured");
    expect(result.usage?.capturedAt).toBe("2026-09-24T12:11:00.000Z");
    expect(agent.captures).toHaveLength(2);
  });

  test("a read inside the rate limit is served from cache even after a turn", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    await transition("a1", "running");
    await transition("a1", "idle");
    await scheduler.advance(5_000);

    const result = await service.read("a1");

    expect(result.status).toBe("cached");
    expect(agent.captures).toHaveLength(1);
  });

  test("reports a provider that cannot break its context down", async () => {
    const { service, add } = setup();
    add("a1").supportsContextUsage = false;

    expect(await service.read("a1")).toEqual({ status: "unsupported", usage: null, error: null });
  });

  test("reports a failed capture with the last good breakdown", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    await transition("a1", "running");
    await scheduler.advance(60_000);
    agent.answers.push(new Error("control request timed out"));
    // Idle again, but after the watch window so no turn-end capture runs first.
    await scheduler.advance(11 * 60_000);
    await transition("a1", "idle");

    const result = await service.read("a1");

    expect(result.status).toBe("error");
    expect(result.error).toBe("control request timed out");
    expect(result.usage?.capturedAt).toBe("2026-09-24T12:00:00.000Z");
  });

  test("answers pending when an idle agent has no live runtime to ask and cannot start one", async () => {
    const { service, add } = setup();
    const agent = add("a1");
    agent.answers.push(null);

    expect(await service.read("a1")).toEqual({ status: "pending", usage: null, error: null });
  });

  test("two readers of the same agent share one capture", async () => {
    const { service, add } = setup();
    const agent = add("a1");
    agent.hold = true;

    const first = service.read("a1");
    const second = service.read("a1");
    await flush();
    agent.release();

    expect((await first).status).toBe("captured");
    expect((await second).status).toBe("captured");
    expect(agent.captures).toHaveLength(1);
  });

  test("captures run one at a time across agents", async () => {
    const { service, add } = setup();
    const a = add("a1");
    const b = add("b1");
    a.hold = true;
    b.hold = true;

    const first = service.read("a1");
    const second = service.read("b1");
    await flush();
    expect(a.captures).toHaveLength(1);
    expect(b.captures).toHaveLength(0);

    a.release();
    await first;
    await flush();
    expect(b.captures).toHaveLength(1);
    b.release();
    await second;
  });
});

describe("AgentContextUsageService turn-end refresh", () => {
  test("recaptures a watched agent shortly after its turn ends, without starting a runtime", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    agent.lifecycle = "running";
    await service.read("a1");
    await transition("a1", "idle");

    await scheduler.advance(2_000);

    expect(agent.captures).toEqual([{ allowStart: false, lifecycleAtCall: "idle" }]);
    expect((await service.read("a1")).status).toBe("cached");
  });

  test("does not capture when the next turn starts before the refresh fires", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    agent.lifecycle = "running";
    await service.read("a1");
    await transition("a1", "idle");
    await transition("a1", "running");

    await scheduler.advance(2_000);

    expect(agent.captures).toEqual([]);
  });

  test("ignores agents nobody has looked at", async () => {
    const { add, transition, scheduler } = setup();
    const agent = add("a1");
    await transition("a1", "running");
    await transition("a1", "idle");

    await scheduler.advance(10_000);

    expect(agent.captures).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  test("stops refreshing once the watch lapses", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    await scheduler.advance(11 * 60_000);
    await transition("a1", "running");
    await transition("a1", "idle");

    await scheduler.advance(10_000);

    expect(agent.captures).toHaveLength(1);
  });

  test("holds a quick second turn end to the rate limit", async () => {
    const { service, add, transition, scheduler } = setup();
    const agent = add("a1");
    await service.read("a1");
    await transition("a1", "running");
    await transition("a1", "idle");
    await scheduler.advance(2_000);
    expect(agent.captures).toHaveLength(1);
    await scheduler.advance(28_000);
    expect(agent.captures).toHaveLength(2);

    await transition("a1", "running");
    await transition("a1", "idle");
    await scheduler.advance(2_000);
    expect(agent.captures).toHaveLength(2);

    await scheduler.advance(28_000);
    expect(agent.captures).toHaveLength(3);
  });

  test("forgets an agent once it closes", async () => {
    const { service, add, transition, scheduler, agents } = setup();
    add("a1");
    await service.read("a1");
    await transition("a1", "closed");
    agents.delete("a1");

    await transition("a1", "idle");
    await scheduler.advance(10_000);

    expect(await service.read("a1")).toEqual({
      status: "error",
      usage: null,
      error: "Agent a1 not found",
    });
  });
});
