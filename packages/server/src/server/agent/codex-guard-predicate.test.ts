import { describe, expect, it } from "vitest";
import { hasCodexGuardMarker, requiresCodexGuard } from "./codex-guard-predicate.js";

describe("requiresCodexGuard", () => {
  it("is false for a non-codex family, whatever the caller or labels say", () => {
    expect(requiresCodexGuard({ callerAgentId: "child-1", providerFamily: "claude" })).toBe(false);
    expect(
      requiresCodexGuard({
        labels: { "paseo.codex-guarded": "1" },
        providerFamily: "claude",
      }),
    ).toBe(false);
  });

  it("is false for a root/human create on codex: no callerAgentId, no parent label, no marker", () => {
    expect(requiresCodexGuard({ providerFamily: "codex" })).toBe(false);
    expect(
      requiresCodexGuard({ labels: { "some.other.label": "x" }, providerFamily: "codex" }),
    ).toBe(false);
  });

  it("is true for a create with callerAgentId on codex", () => {
    expect(requiresCodexGuard({ callerAgentId: "parent-1", providerFamily: "codex" })).toBe(true);
  });

  it("is true for a label-only child (parent label, no callerAgentId) on codex", () => {
    expect(
      requiresCodexGuard({
        labels: { "paseo.parent-agent-id": "parent-1" },
        providerFamily: "codex",
      }),
    ).toBe(true);
  });

  it("is true whenever the durable marker is present, even with no caller and no parent label", () => {
    expect(
      requiresCodexGuard({
        labels: { "paseo.codex-guarded": "1" },
        providerFamily: "codex",
      }),
    ).toBe(true);
  });

  it("ignores an empty-string parent label the same way getParentAgentIdFromLabels does", () => {
    expect(
      requiresCodexGuard({
        labels: { "paseo.parent-agent-id": "" },
        providerFamily: "codex",
      }),
    ).toBe(false);
  });
});

describe("hasCodexGuardMarker", () => {
  it("is true only for the exact marker value", () => {
    expect(hasCodexGuardMarker({ "paseo.codex-guarded": "1" })).toBe(true);
    expect(hasCodexGuardMarker({ "paseo.codex-guarded": "true" })).toBe(false);
    expect(hasCodexGuardMarker(undefined)).toBe(false);
    expect(hasCodexGuardMarker({})).toBe(false);
  });
});
