import { describe, expect, it } from "vitest";

import {
  JEV_ARCHIVED_DESCENDANT_WINDOW_MS,
  type JevAgentPlacement,
  resolveJevAgentCwds,
} from "./agent-cwds.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");

function agent(
  id: string,
  cwd: string,
  parent?: string,
  archivedAt?: string | null,
): JevAgentPlacement {
  const labels: Record<string, string> = parent ? { "paseo.parent-agent-id": parent } : {};
  return {
    id,
    cwd,
    labels,
    archivedAt: archivedAt ?? null,
  };
}

describe("resolveJevAgentCwds", () => {
  it("adds the agent's own, ancestor and descendant cwds", () => {
    const placements = [
      agent("root", "/home/u"),
      agent("mid", "/home/u/paseo", "root"),
      agent("leaf", "/home/u/mobile-worktrees/app", "mid"),
      agent("other", "/elsewhere"),
    ];
    expect(resolveJevAgentCwds(["mid"], placements, NOW)?.sort()).toEqual(
      ["/home/u", "/home/u/mobile-worktrees/app", "/home/u/paseo"].sort(),
    );
  });

  it("counts a descendant archived within 24 hours and drops one archived before", () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const old = new Date(NOW - JEV_ARCHIVED_DESCENDANT_WINDOW_MS - 60_000).toISOString();
    const placements = [
      agent("leader", "/home/u"),
      agent("recent", "/home/u/backend-net", "leader", recent),
      agent("old", "/home/u/bn-worktrees/x", "leader", old),
    ];
    expect(resolveJevAgentCwds(["leader"], placements, NOW)?.sort()).toEqual(
      ["/home/u", "/home/u/backend-net"].sort(),
    );
  });

  it("keeps walking below a descendant archived before the window, and counts it with its live descendant", () => {
    const old = new Date(NOW - JEV_ARCHIVED_DESCENDANT_WINDOW_MS - 60_000).toISOString();
    const placements = [
      agent("leader", "/home/u/scratch"),
      agent("archived", "/home/u/scratch2", "leader", old),
      agent("live", "/home/u/mobile-worktrees/app", "archived"),
    ];
    expect(resolveJevAgentCwds(["leader"], placements, NOW)?.sort()).toEqual(
      ["/home/u/mobile-worktrees/app", "/home/u/scratch", "/home/u/scratch2"].sort(),
    );
  });

  it("drops a whole subtree once every agent in it is archived before the window", () => {
    const old = new Date(NOW - JEV_ARCHIVED_DESCENDANT_WINDOW_MS - 60_000).toISOString();
    const recent = new Date(NOW - 60_000).toISOString();
    const placements = [
      agent("leader", "/home/u"),
      agent("old", "/home/u/a", "leader", old),
      agent("older", "/home/u/b", "old", old),
      agent("old-parent", "/home/u/c", "leader", old),
      agent("recent-child", "/home/u/backend-net", "old-parent", recent),
    ];
    expect(resolveJevAgentCwds(["leader"], placements, NOW)?.sort()).toEqual(
      ["/home/u", "/home/u/backend-net", "/home/u/c"].sort(),
    );
  });

  it("answers null for an unknown agent, so the call is excluded", () => {
    expect(resolveJevAgentCwds(["ghost"], [agent("a", "/x")], NOW)).toBeNull();
  });

  it("stops on a parent cycle", () => {
    const placements = [agent("a", "/a", "b"), agent("b", "/b", "a")];
    expect(resolveJevAgentCwds(["a"], placements, NOW)?.sort()).toEqual(["/a", "/b"]);
  });
});
