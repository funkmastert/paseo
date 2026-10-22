import type { ExplorerTab } from "@/stores/panel-store";

export function buildExplorerAvailableTabs(input: {
  isGit: boolean;
  hasPullRequestLedger: boolean;
  showPrTab: boolean;
}): ExplorerTab[] {
  const tabs: ExplorerTab[] = input.isGit ? ["changes", "files"] : ["files"];
  if (!input.isGit) return tabs;
  // The ledger-backed "prs" tab is unconditional on git workspaces; the single-PR tab it
  // replaces stays conditional on a branch PR existing, for hosts that don't serve it yet.
  if (input.hasPullRequestLedger) tabs.push("prs");
  else if (input.showPrTab) tabs.push("pr");
  return tabs;
}

export function resolveExplorerSidebarTab(input: {
  activeTab: ExplorerTab;
  isGit: boolean;
  availableTabs: ExplorerTab[];
}): ExplorerTab {
  let requestedTab: ExplorerTab =
    !input.isGit &&
    (input.activeTab === "changes" || input.activeTab === "pr" || input.activeTab === "prs")
      ? "files"
      : input.activeTab;
  // The "pr"/"prs" alias is resolved here, against this host's actual availableTabs, rather than
  // migrated blind in explorer-tab-memory.ts — a host without the ledger feature only has "pr".
  if (requestedTab === "pr" && input.availableTabs.includes("prs")) {
    requestedTab = "prs";
  } else if (requestedTab === "prs" && !input.availableTabs.includes("prs")) {
    requestedTab = "pr";
  }
  return input.availableTabs.includes(requestedTab)
    ? requestedTab
    : (input.availableTabs[0] ?? "files");
}
