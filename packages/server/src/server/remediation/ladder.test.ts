import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PushPayload, PushSendMeta } from "../push/index.js";
import type { RemediationConfig } from "./config.js";
import type { RemediationObservation } from "./contract.js";
import {
  RemediationLadder,
  type RemediationAgentRequest,
  type RemediationAgentView,
  type RemediationLadderDependencies,
} from "./ladder.js";

const MINUTE = 60_000;
const START = Date.parse("2026-09-24T12:00:00.000Z");

interface SentPush {
  payload: PushPayload;
  meta: PushSendMeta | undefined;
}

class FakeFleet implements RemediationLadderDependencies {
  readonly created: RemediationAgentRequest[] = [];
  readonly cancelled: string[] = [];
  readonly archived: string[] = [];
  readonly views = new Map<string, RemediationAgentView>();
  accountBlocker: string | null = null;
  createError: Error | null = null;
  private next = 1;

  async createAgent(request: RemediationAgentRequest): Promise<{ agentId: string }> {
    if (this.createError) throw this.createError;
    this.created.push(request);
    const agentId = `agent-${this.next++}`;
    this.views.set(agentId, { status: "running", totalTokens: 0 });
    return { agentId };
  }

  async inspectAgent(agentId: string): Promise<RemediationAgentView> {
    return this.views.get(agentId) ?? { status: "gone" };
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.cancelled.push(agentId);
    this.views.set(agentId, { status: "idle", finalText: null });
  }

  async archiveAgent(agentId: string): Promise<void> {
    this.archived.push(agentId);
  }

  async findAccountBlocker(): Promise<string | null> {
    return this.accountBlocker;
  }

  finish(agentId: string, finalText: string): void {
    this.views.set(agentId, { status: "idle", finalText });
  }
}

let dir: string;
let statePath: string;
let nowMs: number;
let fleet: FakeFleet;
let pushes: SentPush[];
let config: RemediationConfig | undefined;
const ladders: RemediationLadder[] = [];

function buildLadder(): RemediationLadder {
  const ladder = new RemediationLadder({
    dependencies: fleet,
    getPushNotificationSender: () => ({
      send: async (payload, meta) => {
        pushes.push({ payload, meta });
      },
    }),
    serverId: "srv",
    readDaemonConfig: () => ({ remediation: config }),
    statePath,
    logger: pino({ level: "silent" }),
    now: () => nowMs,
    pollIntervalMs: 60 * 60 * MINUTE,
  });
  ladders.push(ladder);
  return ladder;
}

function observation(overrides: Partial<RemediationObservation> = {}): RemediationObservation {
  return {
    key: "orphan-build-daemons",
    kind: "orphan-build-daemons",
    active: true,
    remedy: "live",
    title: "Orphaned build daemons",
    summary: "3 daemons hold 6.1 GB.",
    evidence: "pid 12 GradleDaemon 1.2 GB",
    attempts: [
      { remedy: "reaper", outcome: "acted", detail: "reaped pid 12", at: "2026-09-24T12:00:00Z" },
    ],
    graceMs: 10 * MINUTE,
    escalation: { task: "Find what keeps respawning the daemons and stop it." },
    ...overrides,
  };
}

function alerts(): SentPush[] {
  return pushes.filter((push) => push.meta?.level !== "record");
}

function records(): string[] {
  return pushes
    .filter((push) => push.meta?.level === "record")
    .map((push) => String(push.payload.data?.reason));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "remediation-ladder-"));
  statePath = path.join(dir, "remediation", "state.json");
  nowMs = START;
  fleet = new FakeFleet();
  pushes = [];
  config = undefined;
});

afterEach(async () => {
  for (const ladder of ladders.splice(0)) ladder.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("RemediationLadder rung 2", () => {
  it("waits out a live remedy's grace window, then starts one labelled agent", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation());
    expect(fleet.created).toHaveLength(0);
    expect(records()).toEqual(["remediation_opened"]);

    nowMs += 9 * MINUTE;
    await ladder.observe(observation());
    expect(fleet.created).toHaveLength(0);

    nowMs += 1 * MINUTE;
    await ladder.observe(observation());
    await ladder.observe(observation());
    expect(fleet.created).toHaveLength(1);
    const request = fleet.created[0]!;
    expect(request.provider).toBe("claude");
    expect(request.labels).toEqual({
      "paseo.task-class": "standard",
      "paseo.budget": "2000000",
      "paseo.remediation": "orphan-build-daemons",
      "paseo.remediation-key": "orphan-build-daemons",
      "paseo.agent-type": "worker",
    });
    expect(request.prompt).toContain("Find what keeps respawning the daemons and stop it.");
    expect(request.prompt).toContain("pid 12 GradleDaemon 1.2 GB");
    expect(request.prompt).toContain("reaper (acted): reaped pid 12");
    expect(request.prompt).toContain("REMEDIATION: NOT_FIXED —");
    expect(records()).toEqual(["remediation_opened", "remediation_agent_started"]);
    expect(alerts()).toHaveLength(0);
  });

  it("uses the config's graceMinutes over the observation's graceMs", async () => {
    config = { conditions: { "orphan-build-daemons": { graceMinutes: 0 } } };
    const ladder = buildLadder();
    await ladder.observe(observation());
    expect(fleet.created).toHaveLength(1);
  });

  it("escalates a remedy-less condition with a task on the first sweep at grace 0", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ remedy: "none", graceMs: undefined }));
    expect(fleet.created).toHaveLength(1);
  });

  it("takes the task class from the observation, then the condition, then the config", async () => {
    config = {
      escalation: { taskClass: "mechanical", maxConcurrent: 3 },
      conditions: { "disk-low": { taskClass: "standard", budgetTokens: 500 } },
    };
    const ladder = buildLadder();
    await ladder.observe(observation({ key: "a", graceMs: 0 }));
    await ladder.observe(observation({ key: "b", kind: "disk-low", graceMs: 0 }));
    await ladder.observe(
      observation({
        key: "c",
        kind: "disk-low",
        graceMs: 0,
        escalation: { task: "t", taskClass: "hard", cwd: "/tmp/somewhere" },
      }),
    );
    expect(fleet.created.map((request) => request.labels["paseo.task-class"])).toEqual([
      "mechanical",
      "standard",
      "hard",
    ]);
    expect(fleet.created[1]!.labels["paseo.budget"]).toBe("500");
    expect(fleet.created[2]!.cwd).toBe("/tmp/somewhere");
  });

  it("archives a FIXED agent and records it, with no push to a person", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    fleet.finish("agent-1", "Killed the loop.\nREMEDIATION: FIXED — stopped the respawning build");
    await ladder.tick();
    expect(fleet.archived).toEqual(["agent-1"]);
    await ladder.observe(observation({ active: false }));
    expect(records()).toEqual([
      "remediation_opened",
      "remediation_agent_started",
      "remediation_fixed",
      "remediation_resolved",
    ]);
    expect(alerts()).toHaveLength(0);
  });

  it("pushes once on NOT_FIXED, links the unarchived agent, and says what was tried", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    fleet.finish("agent-1", "REMEDIATION: NOT_FIXED — a stuck build keeps respawning them");
    await ladder.tick();
    await ladder.tick();
    await ladder.observe(observation());
    expect(fleet.archived).toEqual([]);
    expect(alerts()).toHaveLength(1);
    const push = alerts()[0]!;
    expect(push.meta).toEqual({ level: "alert", dedupeKey: "remediation:orphan-build-daemons" });
    expect(push.payload.title).toBe("Needs you: Orphaned build daemons");
    expect(push.payload.body).toContain("reaper acted: reaped pid 12");
    expect(push.payload.body).toContain(
      "REMEDIATION: NOT_FIXED — a stuck build keeps respawning them",
    );
    expect(push.payload.data?.agentId).toBe("agent-1");
  });

  it("treats a missing report line as not fixed", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0, level: "urgent" }));
    fleet.finish("agent-1", "I think it is fine now.");
    await ladder.tick();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.meta?.level).toBe("urgent");
    expect(alerts()[0]!.payload.body).toContain("without a REMEDIATION line");
  });

  it("still reaches rung 3 when the episode closed while its agent ran", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    await ladder.observe(observation({ active: false }));
    expect(records()).toContain("remediation_resolved");
    fleet.finish("agent-1", "REMEDIATION: NOT_FIXED — the snapshot push was rejected");
    await ladder.tick();
    expect(alerts()).toHaveLength(1);
    await ladder.tick();
    expect(alerts()).toHaveLength(1);
  });

  it("gives a FIXED agent one more grace window, then rung 3 without a second agent", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 5 * MINUTE }));
    nowMs += 5 * MINUTE;
    await ladder.observe(observation({ graceMs: 5 * MINUTE }));
    expect(fleet.created).toHaveLength(1);
    fleet.finish("agent-1", "REMEDIATION: FIXED — reaped them all");
    await ladder.tick();
    await ladder.observe(observation({ graceMs: 5 * MINUTE }));
    expect(alerts()).toHaveLength(0);
    nowMs += 5 * MINUTE;
    await ladder.observe(observation({ graceMs: 5 * MINUTE }));
    expect(fleet.created).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("REMEDIATION: FIXED — reaped them all");
    expect(alerts()[0]!.payload.body).toContain("still holds");
  });

  it("sends a new episode inside the cooldown straight to rung 3", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    fleet.finish("agent-1", "REMEDIATION: FIXED — done");
    await ladder.tick();
    await ladder.observe(observation({ active: false }));
    nowMs += 30 * MINUTE;
    await ladder.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("cooldown");
    await ladder.observe(observation({ graceMs: 0 }));
    expect(alerts()).toHaveLength(1);

    await ladder.observe(observation({ active: false }));
    nowMs += 240 * MINUTE;
    await ladder.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(2);
  });

  it("cancels an agent past its timeout and escalates", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    nowMs += 45 * MINUTE;
    await ladder.tick();
    expect(fleet.cancelled).toEqual(["agent-1"]);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("did not report within 45 minutes");
  });

  it("cancels an agent past its token budget and escalates", async () => {
    config = { escalation: { budgetTokens: 1000 } };
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    fleet.views.set("agent-1", { status: "running", totalTokens: 1001 });
    await ladder.tick();
    expect(fleet.cancelled).toEqual(["agent-1"]);
    expect(alerts()[0]!.payload.body).toContain("token budget");
  });

  it("escalates an agent that errors or disappears", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ key: "a", graceMs: 0 }));
    await ladder.observe(observation({ key: "b", graceMs: 0 }));
    fleet.views.set("agent-1", { status: "error", error: "provider crashed" });
    fleet.views.delete("agent-2");
    await ladder.tick();
    expect(alerts().map((push) => push.payload.body)).toEqual([
      expect.stringContaining("provider crashed"),
      expect.stringContaining("archived or removed"),
    ]);
  });

  it("escalates when the agent cannot be created", async () => {
    fleet.createError = new Error("spawn failed");
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("spawn failed");
  });
});

describe("RemediationLadder limits", () => {
  it("holds a condition for a slot at maxConcurrent without telling anyone", async () => {
    config = { escalation: { maxConcurrent: 1 } };
    const ladder = buildLadder();
    await ladder.observe(observation({ key: "a", graceMs: 0 }));
    await ladder.observe(observation({ key: "b", graceMs: 0 }));
    expect(fleet.created).toHaveLength(1);
    expect(alerts()).toHaveLength(0);
    fleet.finish("agent-1", "REMEDIATION: FIXED — ok");
    await ladder.tick();
    await ladder.observe(observation({ key: "b", graceMs: 0 }));
    expect(fleet.created).toHaveLength(2);
  });

  it("goes to rung 3 once the daily cap is spent, and resets the next day", async () => {
    config = { escalation: { maxPerDay: 1 } };
    const ladder = buildLadder();
    await ladder.observe(observation({ key: "a", graceMs: 0 }));
    await ladder.observe(observation({ key: "b", graceMs: 0 }));
    expect(fleet.created).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("daily cap");

    nowMs += 24 * 60 * MINUTE;
    await ladder.observe(observation({ key: "c", graceMs: 0 }));
    expect(fleet.created).toHaveLength(2);
  });

  it("goes to rung 3 when no account can run the agent", async () => {
    fleet.accountBlocker = "no usable account: account claude-personal is at its usage cap";
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(0);
    expect(alerts()[0]!.payload.body).toContain("claude-personal is at its usage cap");
  });

  it.each([
    ["the escalation rung is off", { escalation: { enabled: false } }],
    ["the condition opts out", { conditions: { "orphan-build-daemons": { escalate: false } } }],
  ] as const)("skips rung 2 when %s", async (_label, value) => {
    config = value;
    const ladder = buildLadder();
    await ladder.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(0);
    expect(alerts()).toHaveLength(1);
  });
});

describe("RemediationLadder rung 3 without an agent", () => {
  it.each(["disabled", "dry-run"] as const)(
    "pushes once for a %s remedy and never starts an agent",
    async (remedy) => {
      const ladder = buildLadder();
      await ladder.observe(observation({ remedy }));
      await ladder.observe(observation({ remedy }));
      expect(fleet.created).toHaveLength(0);
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]!.payload.body).toContain(remedy === "disabled" ? "turned off" : "dry run");
    },
  );

  it("pushes for a condition with no remedy and no task", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ remedy: "none", escalation: undefined }));
    expect(fleet.created).toHaveLength(0);
    expect(alerts()).toHaveLength(1);
  });

  it("pushes after the grace window for a live remedy with no task", async () => {
    const ladder = buildLadder();
    await ladder.observe(observation({ escalation: undefined }));
    expect(alerts()).toHaveLength(0);
    nowMs += 10 * MINUTE;
    await ladder.observe(observation({ escalation: undefined }));
    expect(alerts()).toHaveLength(1);
  });

  it("sends rung 3 to the ledger only when the notify rung or the condition says so", async () => {
    config = { notify: { enabled: false } };
    const ladder = buildLadder();
    await ladder.observe(observation({ key: "a", remedy: "disabled" }));
    config = { conditions: { "orphan-build-daemons": { notify: false } } };
    await ladder.observe(observation({ key: "b", remedy: "disabled" }));
    expect(alerts()).toHaveLength(0);
    expect(records().filter((reason) => reason === "remediation_escalated")).toHaveLength(2);
  });
});

describe("RemediationLadder durability", () => {
  it("reconciles an in-flight agent after a restart instead of starting another", async () => {
    const first = buildLadder();
    await first.start();
    await first.observe(observation({ graceMs: 0 }));
    first.stop();
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.episodes[0].agent.id).toBe("agent-1");

    const second = buildLadder();
    await second.start();
    await second.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(1);
    fleet.finish("agent-1", "REMEDIATION: NOT_FIXED — nope");
    await second.tick();
    expect(alerts()).toHaveLength(1);
  });

  it("remembers a cooldown and the daily count across a restart", async () => {
    config = { escalation: { maxPerDay: 2 } };
    const first = buildLadder();
    await first.start();
    await first.observe(observation({ graceMs: 0 }));
    fleet.finish("agent-1", "REMEDIATION: FIXED — ok");
    await first.tick();
    await first.observe(observation({ active: false }));
    first.stop();

    const second = buildLadder();
    await second.start();
    await second.observe(observation({ graceMs: 0 }));
    expect(fleet.created).toHaveLength(1);
    expect(alerts()[0]!.payload.body).toContain("cooldown");
    await second.observe(observation({ key: "other", graceMs: 0 }));
    await second.observe(observation({ key: "third", graceMs: 0 }));
    expect(fleet.created).toHaveLength(2);
  });

  it("keeps waiting on an agent the restart left unloaded until its timeout", async () => {
    const first = buildLadder();
    await first.start();
    await first.observe(observation({ graceMs: 0 }));
    first.stop();
    fleet.views.set("agent-1", { status: "unloaded" });

    const second = buildLadder();
    await second.start();
    expect(alerts()).toHaveLength(0);
    nowMs += 45 * MINUTE;
    await second.tick();
    expect(alerts()).toHaveLength(1);
  });
});
