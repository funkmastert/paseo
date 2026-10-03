import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierWorld } from "./classifier";
import { describeDecision } from "./decision-summary";
import { createHealthTracker } from "./health";

const world = (models: string[]): ClassifierWorld => ({
  policy: {
    ...DEFAULT_POLICY,
    roles: DEFAULT_POLICY.roles.map((role) =>
      role.id === "worker" ? { ...role, models: ["claude-sonnet-5"], mechanicalModels: models } : role,
    ),
  },
  catalog: new Map([["claude", new Set(["claude-sonnet-5", "claude-haiku-4-5"])]]),
  thinkingCatalog: new Map(),
  pool: { workers: [{ providerId: "claude-work", priority: 1 }], leader: null },
  health: createHealthTracker(),
});

const decide = (models: string[]) =>
  describeDecision(
    classifyAgent(
      { callerAgentId: "c", labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" } },
      world(models),
    ),
  );

describe("describeDecision — pool entries", () => {
  it("names an entry that can never run", () => {
    const text = decide(["claude-haiku-9", "claude-haiku-4-5"]);
    expect(text).toContain("Pool entries that never run: claude-haiku-9");
  });

  it("says nothing about a spelling the catalog resolves", () => {
    expect(decide(["claude-haiku-4-5-20251001"])).not.toContain("never run");
  });
});

describe("describeDecision — output style", () => {
  it("names the style and why, for a child", () => {
    expect(decide(["claude-haiku-4-5"])).toContain("Output style: Concise, because");
  });

  it("says none for a root", () => {
    const text = describeDecision(classifyAgent({ title: "lead" }, world(["claude-haiku-4-5"])));
    expect(text).toContain("Output style: None: this is a root agent");
  });
});
