import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../../shared/tool-profiles";
import type { RoleRecord } from "../../shared/role-policy-schema";
import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { describeRequestedModel, describeTaskClass, explainSummaryLines } from "./explain-summary";

function result(overrides: Partial<RoleModelPolicyExplainResult> = {}): RoleModelPolicyExplainResult {
  return {
    roleId: "worker",
    roleName: "worker",
    tier: 1,
    outcome: "selected",
    model: "claude-sonnet-5",
    deniedTools: [],
    taskClassSource: "default",
    ...overrides,
  };
}

function role(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: "worker",
    name: "worker",
    standard: true,
    aliases: [],
    models: ["claude-sonnet-5"],
    mechanicalModels: [],
    hardModels: [],
    toolProfile: DEFAULT_TOOL_PROFILE,
    ...overrides,
  };
}

describe("describeTaskClass", () => {
  it("names the standard pool when nothing classified the task", () => {
    expect(describeTaskClass(result(), role())).toBe(
      "Task class: none (neither declared nor recognized) — the Standard pool decided.",
    );
  });

  it("distinguishes a declared class from a guessed one", () => {
    const declared = describeTaskClass(
      result({ taskClass: "hard", taskClassSource: "declared" }),
      role({ hardModels: ["claude-opus-5"] }),
    );
    expect(declared).toBe("Task class: hard (declared by the caller) — the Hard pool decided.");

    const guessed = describeTaskClass(
      result({ taskClass: "hard", taskClassSource: "classified" }),
      role({ hardModels: ["claude-opus-5"] }),
    );
    expect(guessed).toBe("Task class: hard (guessed from the text) — the Hard pool decided.");
  });

  // The fallback operators misread as "my Hard pool is being ignored".
  it("says so when the class pool is empty and the standard pool served the request", () => {
    expect(describeTaskClass(result({ taskClass: "mechanical", taskClassSource: "declared" }), role())).toBe(
      "Task class: mechanical (declared by the caller) — the Mechanical pool is empty, so the Standard pool decided.",
    );
  });

  it("reports an unrecognized declared value instead of swallowing it", () => {
    const line = describeTaskClass(
      result({ taskClassSource: "default", unknownDeclaredTaskClass: "trivial" }),
      role(),
    );
    expect(line).toContain('Ignored "trivial": not one of mechanical, standard, hard.');
  });

  it("hedges on which pool served it when no role record is available", () => {
    expect(describeTaskClass(result({ taskClass: "hard", taskClassSource: "declared" }), undefined)).toBe(
      "Task class: hard (declared by the caller) — the Hard pool decided (or the Standard pool, if that one is empty).",
    );
  });

  it("treats an explicitly-declared standard class as the standard pool", () => {
    expect(describeTaskClass(result({ taskClass: "standard", taskClassSource: "declared" }), role())).toBe(
      "Task class: standard (declared by the caller) — the Standard pool decided.",
    );
  });
});

describe("describeRequestedModel", () => {
  it("is omitted when no explicit request was simulated", () => {
    expect(describeRequestedModel(result())).toBeUndefined();
  });

  it("reports an honored request", () => {
    const line = describeRequestedModel(
      result({ requestedModelOverride: { requestedRef: "claude/claude-opus-5", honored: true } }),
    );
    expect(line).toBe("Explicit request claude/claude-opus-5: honored.");
  });

  it("names the override label so it matches what a real agent carries", () => {
    const line = describeRequestedModel(
      result({
        requestedModelOverride: {
          requestedRef: "claude/claude-opus-5",
          honored: false,
          effectiveRef: "claude-haiku-5",
          reason: "not-approved",
        },
      }),
    );
    expect(line).toContain("overridden by policy → claude-haiku-5");
    expect(line).toContain("not a member of the pool this task class resolves to");
    expect(line).toContain("paseo.model-overridden-by-policy=claude/claude-opus-5");
  });

  it("distinguishes an approved-but-unselectable request from an unapproved one", () => {
    const line = describeRequestedModel(
      result({
        requestedModelOverride: {
          requestedRef: "claude/claude-fable-5-1",
          honored: false,
          effectiveRef: "claude-sonnet-5",
          reason: "not-currently-selectable",
        },
      }),
    );
    expect(line).toContain("approved for this role, but not selectable right now");
  });
});

describe("explainSummaryLines", () => {
  it("always prints the role line and the task-class line, request line only when present", () => {
    expect(explainSummaryLines(result(), role())).toHaveLength(2);
    expect(
      explainSummaryLines(
        result({ requestedModelOverride: { requestedRef: "claude/claude-opus-5", honored: true } }),
        role(),
      ),
    ).toHaveLength(3);
  });

  it("keeps the existing role/tool sentence intact", () => {
    const [roleLine] = explainSummaryLines(result({ deniedTools: ["Edit", "Write"] }), role());
    expect(roleLine).toBe(
      "→ worker (via exact mapping): would route to claude-sonnet-5 on whichever pooled account is healthy. Tools denied: Edit, Write.",
    );
  });
});
