import { describe, expect, it } from "vitest";
import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { describeRequestedModel, describeTools, explainSummaryLines } from "./explain-summary";

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
});
