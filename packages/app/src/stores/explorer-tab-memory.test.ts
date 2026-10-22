import { describe, expect, it } from "vitest";
import {
  isExplorerTab,
  migrateExplorerTab,
  resolveExplorerTabForCheckout,
} from "./explorer-tab-memory.js";

describe("migrateExplorerTab", () => {
  it("maps a stored legacy 'pr' forward to 'prs'", () => {
    expect(migrateExplorerTab("pr")).toBe("prs");
  });

  it("leaves every other tab unchanged", () => {
    expect(migrateExplorerTab("changes")).toBe("changes");
    expect(migrateExplorerTab("files")).toBe("files");
    expect(migrateExplorerTab("prs")).toBe("prs");
  });
});

describe("isExplorerTab", () => {
  it("accepts prs as a valid tab", () => {
    expect(isExplorerTab("prs")).toBe(true);
  });
});

describe("resolveExplorerTabForCheckout", () => {
  it("resolves an old persisted 'pr' value to 'prs'", () => {
    const resolved = resolveExplorerTabForCheckout({
      serverId: "server-1",
      cwd: "/repo",
      isGit: true,
      explorerTabByCheckout: { "server-1::/repo": "pr" },
    });
    expect(resolved).toBe("prs");
  });
});
