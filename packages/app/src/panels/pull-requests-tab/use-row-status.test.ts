import { describe, expect, it } from "vitest";
import { resolveRowState, resolveStatusCwd } from "./use-row-status";

describe("resolveStatusCwd", () => {
  it("prefers the viewing workspace's cwd when present", () => {
    expect(resolveStatusCwd("/agent-repo", "/workspace-repo")).toBe("/workspace-repo");
  });

  it("falls back to the creating agent's cwd when the viewing workspace has none", () => {
    expect(resolveStatusCwd("/agent-repo", null)).toBe("/agent-repo");
  });

  it("falls back to an empty string when neither cwd is available", () => {
    expect(resolveStatusCwd("", null)).toBe("");
  });
});

describe("resolveRowState", () => {
  it("returns unknown for a null status (loading, error, unsupported forge, or not found)", () => {
    expect(resolveRowState(null)).toBe("unknown");
  });

  it("returns merged when the status reports merged, regardless of state", () => {
    expect(resolveRowState({ isMerged: true, state: "closed" })).toBe("merged");
  });

  it("returns open for an open, unmerged PR", () => {
    expect(resolveRowState({ isMerged: false, state: "open" })).toBe("open");
  });

  it("returns closed for a closed, unmerged PR", () => {
    expect(resolveRowState({ isMerged: false, state: "closed" })).toBe("closed");
  });
});
