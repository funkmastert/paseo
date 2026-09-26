import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ScheduleCondition } from "@getpaseo/protocol/schedule/condition";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ScheduleService } from "./service.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const WAKE_ON_CHILD_WORK: ScheduleCondition = {
  type: "any",
  conditions: [{ type: "hasActiveChildren" }, { type: "childFinishedSince" }],
};

describe("conditional heartbeats", () => {
  let tempDir: string;
  let agentStorage: AgentStorage;
  let manager: AgentManager;
  let now: Date;
  let service: ScheduleService;
  let steer: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-conditions-test-"));
    await mkdir(join(tempDir, "agents"), { recursive: true });
    agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    steer = vi.spyOn(manager, "steerIntoActiveTurn");
    now = new Date();
    const unused = async (): Promise<never> => {
      throw new Error("heartbeats do not create agents or workspaces");
    };
    service = new ScheduleService({
      paseoHome: tempDir,
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      createAgent: unused,
      createDirectoryWorkspace: unused,
      createPaseoWorktreeWorkspace: unused,
      archiveWorkspace: unused,
      now: () => now,
    });
  });

  afterEach(async () => {
    await agentStorage.flush();
    await rm(tempDir, { recursive: true, force: true });
  });

  // A run's bookkeeping (state persistence, the idle transition's timestamp) trails the promise
  // that reports it. Wait until every agent's newest activity stops moving, then step the clock
  // past it, so "before the heartbeat existed" is unambiguous.
  async function settle(): Promise<void> {
    const newestActivity = () =>
      manager
        .listAgentsForDoneJanitor()
        .map((agent) => agent.lastActivityAt)
        .join("|");
    let previous = "";
    let stable = 0;
    while (stable < 3) {
      await manager.flush();
      await agentStorage.flush();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const current = newestActivity();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
    const start = Date.now();
    while (Date.now() <= start) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function createLeader() {
    return manager.createAgent({ provider: "claude", cwd: tempDir }, undefined, {
      workspaceId: undefined,
    });
  }

  async function createChild(leaderId: string) {
    return manager.createAgent({ provider: "claude", cwd: tempDir }, undefined, {
      workspaceId: undefined,
      labels: { [PARENT_AGENT_ID_LABEL]: leaderId },
    });
  }

  async function advanceAndTick(totalMs: number, stepMs: number): Promise<void> {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      now = new Date(now.getTime() + stepMs);
      await service.tick();
    }
  }

  test("an idle leader with nothing due fires zero turns across one hour of ticks", async () => {
    const leader = await createLeader();
    const child = await createChild(leader.id);
    await manager.runAgent(child.id, "finish before the heartbeat exists");
    await settle();
    // The heartbeat's clock starts after everything the agents did, as it would in life.
    now = new Date();
    const heartbeat = await service.create({
      prompt: "Check on your agents",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
      condition: WAKE_ON_CHILD_WORK,
    });
    const timelineBefore = manager.getTimeline(leader.id).length;

    await advanceAndTick(HOUR, MINUTE);

    const after = await service.inspect(heartbeat.id);
    expect(steer).not.toHaveBeenCalled();
    expect(after.runs).toEqual([]);
    expect(after.lastRunAt).toBeNull();
    expect(manager.getTimeline(leader.id)).toHaveLength(timelineBefore);
    // The slot still advances, so a skipped heartbeat is not re-evaluated every second.
    expect(new Date(after.nextRunAt ?? 0).getTime()).toBeGreaterThan(now.getTime());
  });

  test("a condition that is met fires, once, and stays quiet afterwards", async () => {
    const leader = await createLeader();
    const child = await createChild(leader.id);
    await settle();
    now = new Date();
    const heartbeat = await service.create({
      prompt: "A child finished",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
      condition: { type: "childFinishedSince" },
    });
    await manager.runAgent(child.id, "finish after the heartbeat exists");

    await advanceAndTick(5 * MINUTE, MINUTE);

    const after = await service.inspect(heartbeat.id);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toBe(leader.id);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]?.status).toBe("succeeded");

    // The fire made the leader act after the child finished, so the finish is no longer news.
    await advanceAndTick(HOUR, MINUTE);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  test("a heartbeat with no condition fires on every tick, as it did before conditions", async () => {
    const leader = await createLeader();
    const heartbeat = await service.create({
      prompt: "Tick",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
    });
    expect(heartbeat.condition).toBeUndefined();

    await advanceAndTick(3 * MINUTE, MINUTE);

    expect(steer).toHaveBeenCalledTimes(3);
    expect((await service.inspect(heartbeat.id)).runs).toHaveLength(3);
  });

  test("an explicit always condition fires on every tick", async () => {
    const leader = await createLeader();
    await service.create({
      prompt: "Tick",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
      condition: { type: "always" },
    });

    await advanceAndTick(2 * MINUTE, MINUTE);

    expect(steer).toHaveBeenCalledTimes(2);
  });

  test("a manual run bypasses the condition", async () => {
    const leader = await createLeader();
    const heartbeat = await service.create({
      prompt: "Run now",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
      condition: { type: "hasActiveChildren" },
    });

    await service.runOnce(heartbeat.id);

    expect(steer).toHaveBeenCalledTimes(1);
  });

  test("a condition is stored, replaced and cleared through update", async () => {
    const leader = await createLeader();
    const heartbeat = await service.create({
      prompt: "Tick",
      cadence: { type: "every", everyMs: MINUTE },
      target: { type: "agent", agentId: leader.id },
    });

    const set = await service.update({ id: heartbeat.id, condition: WAKE_ON_CHILD_WORK });
    expect(set.condition).toEqual(WAKE_ON_CHILD_WORK);
    expect((await service.inspect(heartbeat.id)).condition).toEqual(WAKE_ON_CHILD_WORK);

    const cleared = await service.update({ id: heartbeat.id, condition: null });
    expect(cleared.condition).toBeUndefined();
  });

  test("re-registering a named heartbeat replaces its condition", async () => {
    const leader = await createLeader();
    const base = {
      name: "babysit",
      prompt: "Check",
      cadence: { type: "every" as const, everyMs: MINUTE },
      target: { type: "agent" as const, agentId: leader.id },
    };
    const first = await service.createOrReplace({ ...base, condition: WAKE_ON_CHILD_WORK });
    expect(first.condition).toEqual(WAKE_ON_CHILD_WORK);

    const second = await service.createOrReplace(base);
    expect(second.id).toBe(first.id);
    expect(second.condition).toBeUndefined();
  });

  test("a condition on a schedule that starts new agents is rejected", async () => {
    await expect(
      service.create({
        prompt: "Nightly",
        cadence: { type: "every", everyMs: HOUR },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
        condition: { type: "hasActiveChildren" },
      }),
    ).rejects.toThrow("only valid on a heartbeat");
  });
});
