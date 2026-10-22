import { describe, expect, it } from "vitest";
import {
  buildExplorerAvailableTabs,
  resolveExplorerSidebarTab,
} from "./compact-explorer-sidebar-tabs";

describe("buildExplorerAvailableTabs", () => {
  it("includes 'prs' unconditionally on a git workspace when the ledger feature is on (R1)", () => {
    const tabs = buildExplorerAvailableTabs({
      isGit: true,
      hasPullRequestLedger: true,
      showPrTab: false,
    });
    expect(tabs).toEqual(["changes", "files", "prs"]);
  });

  it("falls back to the old conditional 'pr' tab on a host without the ledger feature (R7)", () => {
    const withBranchPr = buildExplorerAvailableTabs({
      isGit: true,
      hasPullRequestLedger: false,
      showPrTab: true,
    });
    expect(withBranchPr).toEqual(["changes", "files", "pr"]);

    const withoutBranchPr = buildExplorerAvailableTabs({
      isGit: true,
      hasPullRequestLedger: false,
      showPrTab: false,
    });
    expect(withoutBranchPr).toEqual(["changes", "files"]);
  });

  it("never shows a PR tab on a non-git workspace", () => {
    const tabs = buildExplorerAvailableTabs({
      isGit: false,
      hasPullRequestLedger: true,
      showPrTab: true,
    });
    expect(tabs).toEqual(["files"]);
  });
});

describe("resolveExplorerSidebarTab", () => {
  it("falls back to 'changes' when the stored tab isn't available", () => {
    const resolved = resolveExplorerSidebarTab({
      activeTab: "prs",
      isGit: true,
      availableTabs: ["changes", "files"],
    });
    expect(resolved).toBe("changes");
  });

  it("keeps 'prs' when it is available", () => {
    const resolved = resolveExplorerSidebarTab({
      activeTab: "prs",
      isGit: true,
      availableTabs: ["changes", "files", "prs"],
    });
    expect(resolved).toBe("prs");
  });

  it("coerces 'changes'/'pr'/'prs' to 'files' on a non-git workspace", () => {
    expect(
      resolveExplorerSidebarTab({ activeTab: "prs", isGit: false, availableTabs: ["files"] }),
    ).toBe("files");
  });

  it("resolves a stored 'pr' to 'prs' when the ledger-backed tab is available", () => {
    const resolved = resolveExplorerSidebarTab({
      activeTab: "pr",
      isGit: true,
      availableTabs: ["changes", "files", "prs"],
    });
    expect(resolved).toBe("prs");
  });

  it("keeps a stored 'pr' as 'pr' when the host has no ledger-backed 'prs' tab", () => {
    const resolved = resolveExplorerSidebarTab({
      activeTab: "pr",
      isGit: true,
      availableTabs: ["changes", "files", "pr"],
    });
    expect(resolved).toBe("pr");
  });

  it("falls back a stored 'prs' to 'pr' when only the legacy tab is available", () => {
    const resolved = resolveExplorerSidebarTab({
      activeTab: "prs",
      isGit: true,
      availableTabs: ["changes", "files", "pr"],
    });
    expect(resolved).toBe("pr");
  });
});
