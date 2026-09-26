import { describe, expect, it } from "vitest";
import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import {
  describeMcp,
  describeOutcome,
  describeRequestedModel,
  describeRequestedThinking,
  describeThinking,
  describeTools,
  describeOutputStyle,
  describeUnadvertisedEntries,
  explainSummaryLines,
} from "./explain-summary";

/**
 * These assert FORMATTING only. The sentences explaining a decision come from
 * the classifier (`result.reasons.*`) and are asserted in
 * server/classifier.test.ts — asserting them again here is exactly the
 * duplication this panel used to carry.
 */
function result(overrides: Partial<RoleModelPolicyExplainResult> = {}): RoleModelPolicyExplainResult {
  return {
    roleId: "worker",
    roleName: "worker",
    roleSource: "agent-type-mapping",
    tier: 1,
    outcome: "selected",
    model: "claude-sonnet-5",
    pool: ["claude-sonnet-5"],
    poolSlot: "standard",
    fellBackToStandardPool: false,
    deniedTools: [],
    taskClassSource: "default",
    account: { kind: "worker", providerId: "claude-work", usableProviderIds: ["claude-work", "claude-personal"] },
    reasons: {
      role: "worker, from the agent-type mapping.",
      taskClass: "none — nothing declared one.",
      model: "claude-sonnet-5 is the first selectable entry in the standard pool.",
      tools: "Nothing is denied.",
      account: "claude-work has the most headroom.",
    },
    ...overrides,
  };
}

describe("explainSummaryLines", () => {
  it("prints one line per part of the decision, each carrying the classifier's own reason", () => {
    expect(explainSummaryLines(result())).toEqual([
      "Role: worker, from the agent-type mapping.",
      "Task class: none — nothing declared one.",
      "Model: would route to claude-sonnet-5 on whichever pooled account is healthy — claude-sonnet-5 is the first selectable entry in the standard pool.",
      "Tools: nothing denied — Nothing is denied.",
      "Account: claude-work — claude-work has the most headroom.",
    ]);
  });

  it("says the model is left alone when the role has no pool", () => {
    const lines = explainSummaryLines(result({ outcome: "unconfigured", model: undefined, pool: [] }));
    expect(lines[2]).toContain("the model is left as requested");
  });

  it("spells a pinned ref as provider/model", () => {
    const lines = explainSummaryLines(result({ provider: "codex", model: "gpt-5" }));
    expect(lines[2]).toContain("would route to codex/gpt-5");
  });

  it("adds the explicit-request line only when one was simulated", () => {
    expect(explainSummaryLines(result())).toHaveLength(5);
    expect(
      explainSummaryLines(result({ requestedModelOverride: { requestedRef: "claude/claude-opus-5", honored: true } })),
    ).toHaveLength(6);
  });
});

describe("describeTools", () => {
  it("reports what would actually be denied", () => {
    expect(describeTools(result({ deniedTools: ["Bash", "Write"] }))).toContain("Tools denied: Bash, Write");
  });

  /**
   * The preview's old bug: it printed the ROLE's configured profile, so a
   * guessed `reviewer` looked read-only here while the create hook would have
   * withheld that profile entirely and denied nothing.
   */
  it("separates what applies from what was withheld", () => {
    const line = describeTools(
      result({
        deniedTools: [],
        toolsWithheld: { profileKind: "read-only", deniedTools: ["Bash", "Write"] },
      }),
    );
    expect(line).toContain("Tools: nothing denied");
    expect(line).toContain("Withheld: the read-only profile (Bash, Write) would apply if the agent were labelled.");
  });
});

describe("describeRequestedModel", () => {
  it("is absent when no explicit request was simulated", () => {
    expect(describeRequestedModel(result())).toBeUndefined();
  });

  it("names the label a real overridden agent would carry", () => {
    const line = describeRequestedModel(
      result({
        requestedModelOverride: {
          requestedRef: "claude/claude-opus-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-approved",
        },
      }),
    );
    expect(line).toContain("overridden by policy → claude-sonnet-5");
    expect(line).toContain("paseo.model-overridden-by-policy=claude/claude-opus-5");
  });

  it("distinguishes approved-but-unavailable from never-approved", () => {
    const line = describeRequestedModel(
      result({
        requestedModelOverride: {
          requestedRef: "claude/claude-opus-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-currently-selectable",
        },
      }),
    );
    expect(line).toContain("approved for this role, but not selectable right now");
  });

  it("flags an allowlisted, unadvertised request as honored but UNVERIFIED, naming the label a real agent carries", () => {
    const line = describeRequestedModel(
      result({ requestedModelOverride: { requestedRef: "claude/claude-opus-5-5", honored: true, unadvertised: true } }),
    );
    expect(line).toContain("honored, UNVERIFIED");
    expect(line).toContain("allowUnlistedModels");
    expect(line).toContain("paseo.model-unadvertised=claude/claude-opus-5-5");
  });

  it("says a catalog-missing refusal is liftable, instead of blaming capacity", () => {
    const line = describeRequestedModel(
      result({
        requestedModelOverride: {
          requestedRef: "claude/claude-opus-5-5",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-currently-selectable",
          missingFromCatalog: true,
        },
      }),
    );
    expect(line).toContain("catalog doesn't list it and allowUnlistedModels doesn't name it");
    expect(line).not.toContain("capped");
  });
});

describe("describeOutcome — unverified pool default", () => {
  it("says so when the selected model is one the catalog doesn't list", () => {
    const line = describeOutcome(result({ model: "claude-opus-5-5", modelUnadvertised: true }));
    expect(line).toContain("would route to claude-opus-5-5 on whichever pooled account is healthy (UNVERIFIED");
  });

  it("stays quiet for a listed model", () => {
    expect(describeOutcome(result())).not.toContain("UNVERIFIED");
  });
});

describe("describeOutputStyle", () => {
  it("prints the classifier's own sentence", () => {
    const line = describeOutputStyle(
      result({ reasons: { ...result().reasons, outputStyle: "Concise, because a subagent's narration is read by its leader." } }),
    );
    expect(line).toBe("Output style: Concise, because a subagent's narration is read by its leader.");
  });

  it("prints nothing for a plugin that predates the output style", () => {
    expect(describeOutputStyle(result())).toBeUndefined();
  });
});

describe("describeUnadvertisedEntries", () => {
  it("is omitted when every pool entry is advertised", () => {
    expect(describeUnadvertisedEntries(result())).toBeUndefined();
    expect(describeUnadvertisedEntries(result({ unadvertisedPoolEntries: [] }))).toBeUndefined();
  });

  it("names the skipped entries and how one can still run", () => {
    const line = describeUnadvertisedEntries(result({ unadvertisedPoolEntries: ["claude-opus-5-5"] }));
    expect(line).toContain("claude-opus-5-5");
    expect(line).toContain("allowUnlistedModels");
  });
});

describe("describeThinking", () => {
  const thinkingReason = "Ultra Code, because this is a root agent, the leader by definition, and the policy runs leaders at Ultra Code.";

  it("prints the classifier's own sentence, right after the model line", () => {
    const lines = explainSummaryLines(
      result({
        thinking: { outcome: "leader-rule", optionId: "ultracode", modelRef: "claude-opus-5-5", wanted: "ultracode" },
        reasons: { ...result().reasons, thinking: thinkingReason },
      }),
    );
    expect(lines[3]).toBe(`Thinking: ${thinkingReason}`);
    expect(lines[2]).toMatch(/^Model: /);
  });

  it("prints nothing for a plugin that predates the thinking decision", () => {
    expect(describeThinking(result())).toBeUndefined();
    expect(explainSummaryLines(result()).some((line) => line.startsWith("Thinking"))).toBe(false);
  });
});

describe("describeRequestedThinking", () => {
  it("is absent when no thinking level was simulated", () => {
    expect(
      describeRequestedThinking(result({ thinking: { outcome: "task-class-default", optionId: "high", wanted: "high" } })),
    ).toBeUndefined();
  });

  it("says an honored request was honored", () => {
    expect(
      describeRequestedThinking(result({ thinking: { outcome: "requested", optionId: "max", wanted: "max", requested: "max" } })),
    ).toBe("Explicit thinking request Max: honored.");
  });

  it("names the label a real overridden agent would carry", () => {
    const line = describeRequestedThinking(
      result({
        thinking: {
          outcome: "requested",
          optionId: "xhigh",
          wanted: "ultracode",
          subagentCapped: true,
          requested: "ultracode",
          override: { requested: "ultracode", applied: "xhigh", reason: "subagent-no-ultracode" },
        },
      }),
    );
    expect(line).toBe(
      "Explicit thinking request Ultra Code: overridden by policy → Extra High. A real agent would carry paseo.thinking-overridden-by-policy=ultracode.",
    );
  });

  it("says a removed request was removed", () => {
    const line = describeRequestedThinking(
      result({
        thinking: {
          outcome: "no-thinking-options",
          requested: "max",
          override: { requested: "max", reason: "no-thinking-options" },
        },
      }),
    );
    expect(line).toContain("removed");
    expect(line).toContain("paseo.thinking-overridden-by-policy=max");
  });
});

describe("describeMcp", () => {
  it("names the servers, the connectors and the label a real agent would carry", () => {
    const line = describeMcp(
      result({
        reasons: { ...result().reasons, mcp: "Why." },
        mcp: {
          scoped: true,
          gatewayServers: ["zeeq", "linear"],
          withheldServers: ["slack"],
          claudeAiConnectors: false,
          grants: [],
          scopeLabel: "zeeq,linear",
        },
      }),
    );
    expect(line).toBe("MCP servers: zeeq, linear — Why. A real agent would carry paseo.mcp-scope=zeeq,linear.");
  });

  it("says all for an unscoped agent, and nothing for a plugin that sent no MCP decision", () => {
    const unscoped = result({
      reasons: { ...result().reasons, mcp: "Root." },
      mcp: { scoped: false, gatewayServers: ["zeeq"], withheldServers: [], claudeAiConnectors: true, grants: [] },
    });
    expect(describeMcp(unscoped)).toBe("MCP servers: all — Root.");
    expect(describeMcp(result())).toBeUndefined();
  });
});
