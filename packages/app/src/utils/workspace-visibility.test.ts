import { describe, expect, test } from "vitest";
import { isHiddenAgentWorkspace } from "./workspace-visibility";

describe("isHiddenAgentWorkspace", () => {
  test("hides an agent-made workspace with no pin", () => {
    expect(isHiddenAgentWorkspace({ createdBy: "agent", pinnedAt: null })).toBe(true);
  });

  test("shows an agent-made workspace once it is pinned", () => {
    expect(
      isHiddenAgentWorkspace({ createdBy: "agent", pinnedAt: "2026-07-12T12:00:00.000Z" }),
    ).toBe(false);
  });

  test("never hides a person-made workspace, pinned or not", () => {
    expect(isHiddenAgentWorkspace({ createdBy: "person", pinnedAt: null })).toBe(false);
    expect(
      isHiddenAgentWorkspace({ createdBy: "person", pinnedAt: "2026-07-12T12:00:00.000Z" }),
    ).toBe(false);
  });

  test("a missing createdBy (COMPAT: older daemon) reads as person", () => {
    expect(isHiddenAgentWorkspace({ pinnedAt: null })).toBe(false);
    expect(isHiddenAgentWorkspace({})).toBe(false);
  });
});
