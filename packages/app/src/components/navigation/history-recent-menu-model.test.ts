import { describe, expect, it } from "vitest";
import type { NavHistoryEntry } from "@/stores/navigation-history-store";
import {
  HISTORY_RECENT_MENU_MAX_ENTRIES,
  resolveHistoryRecentEntryLabel,
  selectRecentHistoryEntries,
  type HistoryRecentTabLabels,
} from "./history-recent-menu-model";

function entry(workspaceId: string, target?: NavHistoryEntry["target"]): NavHistoryEntry {
  return { serverId: "server-1", workspaceId, target };
}

const alwaysValid = () => true;

describe("selectRecentHistoryEntries", () => {
  it("excludes the current location (the back stack's top entry)", () => {
    const backStack = [entry("a"), entry("b")];

    const result = selectRecentHistoryEntries(backStack, alwaysValid);

    expect(result).toEqual([{ entry: entry("a"), depth: 1 }]);
  });

  it("orders results most recent first", () => {
    const backStack = [entry("a"), entry("b"), entry("c"), entry("d")];

    const result = selectRecentHistoryEntries(backStack, alwaysValid);

    expect(result.map((r) => r.entry.workspaceId)).toEqual(["c", "b", "a"]);
    expect(result.map((r) => r.depth)).toEqual([1, 2, 3]);
  });

  it("caps at maxEntries", () => {
    const backStack = Array.from({ length: 12 }, (_, i) => entry(`w${i}`));

    const result = selectRecentHistoryEntries(backStack, alwaysValid, 3);

    expect(result).toHaveLength(3);
    // Current is w11 (top); the next 3 behind it are w10, w9, w8.
    expect(result.map((r) => r.entry.workspaceId)).toEqual(["w10", "w9", "w8"]);
  });

  it("skips invalid entries without counting them toward depth", () => {
    const backStack = [entry("a"), entry("b"), entry("c")]; // "b" is stale

    const result = selectRecentHistoryEntries(
      backStack,
      (candidate) => candidate.workspaceId !== "b",
    );

    expect(result).toEqual([{ entry: entry("a"), depth: 1 }]);
  });

  it("keeps only the closest occurrence of a duplicate location, distinct by value", () => {
    const backStack = [entry("a"), entry("b"), entry("a"), entry("c")];

    const result = selectRecentHistoryEntries(backStack, alwaysValid);

    // Current is "c". Walking down: "a" (depth 1, kept), "b" (depth 2, kept), "a" again
    // (depth 3, dropped as a duplicate of the depth-1 "a").
    expect(result).toEqual([
      { entry: entry("a"), depth: 1 },
      { entry: entry("b"), depth: 2 },
    ]);
  });

  it("returns an empty list when there's nothing behind the current location", () => {
    expect(selectRecentHistoryEntries([entry("a")], alwaysValid)).toEqual([]);
    expect(selectRecentHistoryEntries([], alwaysValid)).toEqual([]);
  });

  it("defaults maxEntries to HISTORY_RECENT_MENU_MAX_ENTRIES", () => {
    const backStack = Array.from({ length: HISTORY_RECENT_MENU_MAX_ENTRIES + 5 }, (_, i) =>
      entry(`w${i}`),
    );

    const result = selectRecentHistoryEntries(backStack, alwaysValid);

    expect(result).toHaveLength(HISTORY_RECENT_MENU_MAX_ENTRIES);
  });
});

const labels: HistoryRecentTabLabels = {
  newTab: "New tab",
  newAgent: "New agent",
  setup: "Setup",
  terminal: "Terminal",
  browser: "Browser",
  agent: "Agent",
  changes: "Changes",
  files: "Files",
  pullRequest: "Pull request",
  orchestration: "Orchestration",
};

describe("resolveHistoryRecentEntryLabel", () => {
  it("uses the workspace display name as the primary label when the entry names no tab", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1"),
      workspaceDisplayName: "My Workspace",
      agentTitle: null,
      labels,
    });

    expect(result).toEqual({ primary: "My Workspace" });
  });

  it("falls back to the raw workspace id when the display name can't be resolved", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1"),
      workspaceDisplayName: null,
      agentTitle: null,
      labels,
    });

    expect(result).toEqual({ primary: "workspace-1" });
  });

  it("prefers the agent's live title over the generic fallback", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1", { kind: "agent", agentId: "agent-1" }),
      workspaceDisplayName: "My Workspace",
      agentTitle: "Fix the flaky test",
      labels,
    });

    expect(result).toEqual({ primary: "Fix the flaky test", secondary: "My Workspace" });
  });

  it("falls back to the generic agent label when there's no live title", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1", { kind: "agent", agentId: "agent-1" }),
      workspaceDisplayName: "My Workspace",
      agentTitle: null,
      labels,
    });

    expect(result).toEqual({ primary: "Agent", secondary: "My Workspace" });
  });

  it("uses the file's basename for a file tab", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1", { kind: "file", path: "src/components/thing.tsx" }),
      workspaceDisplayName: "My Workspace",
      agentTitle: null,
      labels,
    });

    expect(result).toEqual({ primary: "thing.tsx", secondary: "My Workspace" });
  });

  it("uses a short sha for a commit diff tab", () => {
    const result = resolveHistoryRecentEntryLabel({
      entry: entry("workspace-1", { kind: "commit_diff", sha: "abcdef1234567890" }),
      workspaceDisplayName: "My Workspace",
      agentTitle: null,
      labels,
    });

    expect(result).toEqual({ primary: "abcdef1", secondary: "My Workspace" });
  });

  it("maps terminal, browser, and changes tabs to their fallback labels", () => {
    const terminal = resolveHistoryRecentEntryLabel({
      entry: entry("w", { kind: "terminal", terminalId: "t1" }),
      workspaceDisplayName: "W",
      agentTitle: null,
      labels,
    });
    const browser = resolveHistoryRecentEntryLabel({
      entry: entry("w", { kind: "browser", browserId: "b1" }),
      workspaceDisplayName: "W",
      agentTitle: null,
      labels,
    });
    const changes = resolveHistoryRecentEntryLabel({
      entry: entry("w", { kind: "changes_tree" }),
      workspaceDisplayName: "W",
      agentTitle: null,
      labels,
    });

    expect(terminal.primary).toBe("Terminal");
    expect(browser.primary).toBe("Browser");
    expect(changes.primary).toBe("Changes");
  });
});
