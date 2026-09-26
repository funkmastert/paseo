import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierWorld } from "./classifier";
import { createDecisionLog, DECISION_LOG_PREFIX, type LoggedRequest } from "./decision-log";
import { createHealthTracker } from "./health";

const world: ClassifierWorld = {
  policy: {
    ...DEFAULT_POLICY,
    roles: DEFAULT_POLICY.roles.map((role) =>
      role.id === "worker"
        ? { ...role, models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-4-5-20251001"] }
        : role,
    ),
  },
  catalog: new Map([["claude", new Set(["claude-sonnet-5", "claude-haiku-4-5"])]]),
  thinkingCatalog: new Map([
    [
      "claude",
      new Map([
        ["claude-sonnet-5", { optionIds: ["low", "high", "xhigh"], defaultOptionId: "high" }],
        ["claude-haiku-4-5", { optionIds: [] }],
      ]),
    ],
  ]),
  pool: { workers: [{ providerId: "claude-work", priority: 1 }], leader: { providerId: "claude-personal" } },
  health: createHealthTracker(),
};

function request(overrides: Partial<LoggedRequest> = {}): LoggedRequest {
  return {
    callerAgentId: "caller-1",
    initialPrompt: "fix the typo",
    labels: { "paseo.agent-type": "worker", "paseo.task-class": "mechanical" },
    config: { provider: "claude", title: "typo", cwd: "/repo", model: "claude-haiku-4-5" },
    ...overrides,
  };
}

function decisionFor(input: LoggedRequest) {
  return classifyAgent(
    {
      labels: input.labels,
      title: input.config.title,
      initialPrompt: input.initialPrompt,
      callerAgentId: input.callerAgentId,
      requestedProvider: input.config.provider,
    },
    world,
  );
}

function harness() {
  const lines: string[] = [];
  let nowMs = 1000;
  const log = createDecisionLog({ write: (line) => lines.push(line), now: () => nowMs });
  return { lines, log, advance: (ms: number) => (nowMs += ms) };
}

function parse(line: string): Record<string, any> {
  expect(line.startsWith(`${DECISION_LOG_PREFIX} `)).toBe(true);
  return JSON.parse(line.slice(DECISION_LOG_PREFIX.length + 1));
}

describe("decision log", () => {
  it("writes nothing when a create is only noted, so it cannot report an account that is not yet decided", () => {
    const { lines, log } = harness();
    log.note(request(), decisionFor(request()));
    expect(lines).toEqual([]);
  });

  it("writes one greppable line per create, carrying the account that actually runs", () => {
    const { lines, log } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    const routed = { ...asked, config: { ...asked.config, provider: "claude-work", thinkingOptionId: undefined } };
    log.finish(asked, routed);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const line = parse(lines[0]);
    expect(line).toMatchObject({
      caller: "child",
      role: { id: "worker", source: "agent-type-mapping" },
      taskClass: { value: "mechanical", source: "declared" },
      model: { ref: "claude-haiku-4-5", outcome: "selected", poolSlot: "mechanical", resolvedFrom: "claude-haiku-4-5-20251001" },
      thinking: { optionId: null, outcome: "no-thinking-options" },
      account: { providerId: "claude-work" },
    });
    expect(line.reasons.model).toContain("claude-haiku-4-5-20251001");
  });

  it("is written once even if finish is called again for the same create", () => {
    const { lines, log } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    log.finish(asked, asked);
    log.finish(asked, asked);
    expect(lines).toHaveLength(1);
  });

  it("lists unadvertised pool entries, so a dead pool entry shows in the log", () => {
    const { lines, log } = harness();
    const asked = request();
    const decision = decisionFor(asked);
    log.note(asked, { ...decision, model: { ...decision.model, unadvertisedPoolEntries: ["claude-haiku-9"] } });
    log.finish(asked, asked);
    expect(parse(lines[0]).unadvertisedPoolEntries).toEqual(["claude-haiku-9"]);
  });

  it("marks a refused create with no account", () => {
    const { lines, log } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    log.finish(asked, undefined);
    expect(parse(lines[0]).account).toEqual({ refused: true });
  });

  it("matches the right create when two are in flight", () => {
    const { lines, log } = harness();
    const a = request();
    const b = request({ callerAgentId: "caller-2", config: { provider: "claude", title: "other", cwd: "/repo" } });
    log.note(a, decisionFor(a));
    log.note(b, decisionFor(b));
    log.finish(b, { ...b, config: { ...b.config, provider: "claude-work" } });
    log.finish(a, { ...a, config: { ...a.config, provider: "claude-personal" } });
    expect(lines.map((line) => parse(line).account.providerId)).toEqual(["claude-work", "claude-personal"]);
  });

  it("drops a noted create the account router never finished, rather than logging it late", () => {
    const { lines, log, advance } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    advance(120_000);
    log.finish(asked, asked);
    expect(lines).toEqual([]);
  });

  it("marks a root create", () => {
    const { lines, log } = harness();
    const root = request({ callerAgentId: undefined, labels: undefined });
    log.note(root, decisionFor(root));
    log.finish(root, root);
    expect(parse(lines[0]).caller).toBe("root");
  });
});
