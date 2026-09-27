import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierWorld } from "./classifier";
import { createDecisionLog, DECISION_LOG_PREFIX, DECISION_TOKEN_LABEL, type DecisionLog, type LoggedRequest } from "./decision-log";
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

/** The pairing token the role router's hook would attach for `asked`, as the account hook reads it. */
function tokenOf(log: DecisionLog, asked: LoggedRequest): string | undefined {
  return log.untag(log.tag(asked, asked)).token;
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
    log.finish(tokenOf(log, asked), asked, routed);

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
      outputStyle: "Concise",
      // No gateway snapshot in this world, so nothing is scoped.
      mcp: "all",
    });
    expect(line.reasons.model).toContain("claude-haiku-4-5-20251001");
  });

  it("is written once even if finish is called again for the same create", () => {
    const { lines, log } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    log.finish(tokenOf(log, asked), asked, asked);
    log.finish(tokenOf(log, asked), asked, asked);
    expect(lines).toHaveLength(1);
  });

  it("lists unadvertised pool entries, so a dead pool entry shows in the log", () => {
    const { lines, log } = harness();
    const asked = request();
    const decision = decisionFor(asked);
    log.note(asked, { ...decision, model: { ...decision.model, unadvertisedPoolEntries: ["claude-haiku-9"] } });
    log.finish(tokenOf(log, asked), asked, asked);
    expect(parse(lines[0]).unadvertisedPoolEntries).toEqual(["claude-haiku-9"]);
  });

  it("marks a refused create with no account", () => {
    const { lines, log } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    log.finish(tokenOf(log, asked), asked, undefined);
    expect(parse(lines[0]).account).toEqual({ refused: true });
  });

  it("matches the right create when two are in flight", () => {
    const { lines, log } = harness();
    const a = request();
    const b = request({ callerAgentId: "caller-2", config: { provider: "claude", title: "other", cwd: "/repo" } });
    log.note(a, decisionFor(a));
    log.note(b, decisionFor(b));
    log.finish(tokenOf(log, b), b, { ...b, config: { ...b.config, provider: "claude-work" } });
    log.finish(tokenOf(log, a), a, { ...a, config: { ...a.config, provider: "claude-personal" } });
    expect(lines.map((line) => parse(line).account.providerId)).toEqual(["claude-work", "claude-personal"]);
  });

  it("still logs a create whose decision expired, with the decision unknown rather than a stale one", () => {
    const { lines, log, advance } = harness();
    const asked = request();
    log.note(asked, decisionFor(asked));
    const token = tokenOf(log, asked);
    advance(120_000);
    log.finish(token, asked, asked);
    expect(lines).toHaveLength(1);
    expect(parse(lines[0])).toEqual({ caller: "child", decision: "unknown", model: { final: "claude-haiku-4-5" }, account: { providerId: "claude" } });
  });

  it("logs a create that was never noted, with the decision unknown", () => {
    const { lines, log } = harness();
    log.finish(undefined, request(), undefined);
    expect(parse(lines[0])).toMatchObject({ decision: "unknown", account: { refused: true } });
  });

  it("never throws out of finish, even when writing fails", () => {
    const log = createDecisionLog({
      write: () => {
        throw new Error("disk full");
      },
    });
    const asked = request();
    log.note(asked, decisionFor(asked));
    expect(() => log.finish(tokenOf(log, asked), asked, asked)).not.toThrow();
  });

  it("pairs two creates that differ only in labels exactly, whichever finishes first", () => {
    const { lines, log } = harness();
    const mechanical = request();
    const hard = request({ labels: { "paseo.agent-type": "worker", "paseo.task-class": "hard" } });
    log.note(mechanical, decisionFor(mechanical));
    const mechanicalToken = tokenOf(log, mechanical);
    log.note(hard, decisionFor(hard));
    const hardToken = tokenOf(log, hard);
    log.finish(hardToken, hard, hard);
    log.finish(mechanicalToken, mechanical, mechanical);
    expect(lines.map((line) => parse(line).taskClass.value)).toEqual(["hard", "mechanical"]);
  });

  it("tags only a noted request, and untag strips the token from the labels", () => {
    const { log } = harness();
    const asked = request();
    expect(log.tag(asked, asked)).toBe(asked);
    log.note(asked, decisionFor(asked));
    const tagged = log.tag(asked, asked);
    expect(tagged.labels?.[DECISION_TOKEN_LABEL]).toBeDefined();
    const { token, request: stripped } = log.untag(tagged);
    expect(token).toBe(tagged.labels?.[DECISION_TOKEN_LABEL]);
    expect(stripped.labels).toEqual(asked.labels);
  });

  it("caps an unknown role or task-class label value echoed into the reasons, so a huge label cannot make a huge line", () => {
    const { lines, log } = harness();
    const huge = "x".repeat(2_000_000);
    const asked = request({ labels: { "paseo.agent-role": huge, "paseo.task-class": huge } });
    log.note(asked, decisionFor(asked));
    log.finish(tokenOf(log, asked), asked, asked);
    const line = parse(lines[0]);
    expect(lines[0].length).toBeLessThan(10_000);
    expect(line.reasons.role).toContain(`"${"x".repeat(120)}…"`);
    expect(line.reasons.taskClass).toContain(`"${"x".repeat(120)}…"`);
  });

  it("cuts a capped label between characters, never inside one, so the line jq reads has no lone surrogate", () => {
    const { lines, log } = harness();
    // 119 units, then a two-unit emoji straddling the 120-unit cap.
    const label = `${"x".repeat(119)}\u{1F389}${"y".repeat(200)}`;
    const asked = request({ labels: { "paseo.agent-role": label, "paseo.task-class": label } });
    log.note(asked, decisionFor(asked));
    log.finish(tokenOf(log, asked), asked, asked);
    const line = parse(lines[0]);
    for (const reason of [line.reasons.role, line.reasons.taskClass]) {
      expect((reason as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
      expect(reason).toContain(`"${"x".repeat(119)}…"`);
    }
  });

  it("caps a requested model id, in the decision and in the line, so a huge model id cannot make a huge line", () => {
    const { lines, log } = harness();
    const huge = "z".repeat(2_000_000);
    const asked = request({ config: { ...request().config, model: huge } });
    const decision = classifyAgent(
      {
        labels: asked.labels,
        title: asked.config.title,
        initialPrompt: asked.initialPrompt,
        callerAgentId: asked.callerAgentId,
        requestedProvider: asked.config.provider,
        requestedModel: huge,
      },
      world,
    );
    expect(decision.model.requestedRef).toBe(`claude/${"z".repeat(113)}…`);
    expect(decision.model.override?.requestedRef).toBe(decision.model.requestedRef);
    log.note(asked, decision);
    // The request itself as the result: what the account hook sees when policy left the model alone.
    log.finish(tokenOf(log, asked), asked, asked);
    expect(lines[0].length).toBeLessThan(10_000);
    const line = parse(lines[0]);
    expect(line.model.requested).toBe(`claude/${"z".repeat(113)}…`);
    expect(line.model.final).toBe(`${"z".repeat(120)}…`);
    expect(line.reasons.model).toContain(`claude/${"z".repeat(113)}… was asked for`);
  });

  it("caps a requested thinking level, output style and provider that reach the line", () => {
    const { lines, log } = harness();
    const asked = request({ labels: { "paseo.agent-type": "worker" } });
    const decision = classifyAgent(
      {
        labels: asked.labels,
        callerAgentId: asked.callerAgentId,
        requestedProvider: asked.config.provider,
        requestedThinkingOptionId: "t".repeat(2_000_000),
        requestedOutputStyle: "s".repeat(2_000_000),
      },
      // A catalog with no thinking options known, so the requested level stands as asked.
      { ...world, thinkingCatalog: new Map() },
    );
    log.note(asked, decision);
    log.finish(tokenOf(log, asked), asked, { ...asked, config: { ...asked.config, provider: "p".repeat(2_000_000) } });
    expect(lines[0].length).toBeLessThan(10_000);
    const line = parse(lines[0]);
    expect(line.thinking).toEqual({ optionId: `${"t".repeat(120)}…`, outcome: "model-unknown" });
    expect(line.outputStyle).toBe(`${"s".repeat(120)}…`);
    expect(line.reasons.outputStyle).toContain(`${"s".repeat(120)}…, as the caller's request set it`);
    expect(line.account).toEqual({ providerId: `${"p".repeat(120)}…` });
  });

  it("caps the model and account of a line whose decision is unknown, which come straight from the request", () => {
    const { lines, log } = harness();
    const asked = request({ config: { provider: "p".repeat(2_000_000), model: "z".repeat(2_000_000) } });
    log.finish(undefined, asked, asked);
    expect(lines[0].length).toBeLessThan(1_000);
    expect(parse(lines[0])).toEqual({
      caller: "child",
      decision: "unknown",
      model: { final: `${"z".repeat(120)}…` },
      account: { providerId: `${"p".repeat(120)}…` },
    });
  });

  it("marks a root create", () => {
    const { lines, log } = harness();
    const root = request({ callerAgentId: undefined, labels: undefined });
    log.note(root, decisionFor(root));
    log.finish(tokenOf(log, root), root, root);
    expect(parse(lines[0]).caller).toBe("root");
  });
});
