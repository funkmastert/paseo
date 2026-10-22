import { describe, expect, it } from "vitest";
import { isExplorerTab, resolveExplorerTabForCheckout } from "./explorer-tab-memory.js";

describe("isExplorerTab", () => {
  it("accepts prs as a valid tab", () => {
    expect(isExplorerTab("prs")).toBe(true);
  });
});

describe("resolveExplorerTabForCheckout", () => {
  it("returns a stored legacy 'pr' value unmigrated — availability is resolved downstream", () => {
    const resolved = resolveExplorerTabForCheckout({
      serverId: "server-1",
      cwd: "/repo",
      isGit: true,
      explorerTabByCheckout: { "server-1::/repo": "pr" },
    });
    expect(resolved).toBe("pr");
  });
});
