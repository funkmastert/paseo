import { describe, expect, it } from "vitest";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
  announcements: { serverId: string; agentId: string }[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  const announcements: { serverId: string; agentId: string }[] = [];
  return {
    hostNavigations,
    tabNavigations,
    announcements,
    deps: {
      readAgentNavTarget: () => target,
      resolveShownAgent: () => ({ kind: "self" }),
      announceAgentMove: (input) => {
        announcements.push(input);
      },
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("uses the input workspaceId without reading the nav target", () => {
    const readTargets: { serverId: string; agentId: string }[] = [];
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: null });
    deps.readAgentNavTarget = (input) => {
      readTargets.push(input);
      return { agentWorkspaceId: null };
    };

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(readTargets).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });

  it("opens the live end of a moved agent in its own workspace and says where it went", () => {
    const { deps, tabNavigations, announcements } = createFakeNavigators({
      agentWorkspaceId: null,
    });
    deps.resolveShownAgent = ({ agentId }) =>
      agentId === "retired" ? { kind: "moved", agentId: "successor" } : { kind: "self" };
    deps.readAgentNavTarget = ({ agentId }) => ({
      agentWorkspaceId: agentId === "successor" ? "workspace-2" : WORKSPACE_ID,
    });

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: "retired", workspaceId: WORKSPACE_ID, pin: true },
      deps,
    );

    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: "workspace-2",
        target: { kind: "agent", agentId: "successor" },
        pin: true,
      },
    ]);
    expect(announcements).toEqual([{ serverId: SERVER_ID, agentId: "successor" }]);
  });

  it("opens a stranded handle where it is and names where it went", () => {
    const { deps, tabNavigations, announcements } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });
    deps.resolveShownAgent = () => ({ kind: "stranded", movedToAgentId: "elsewhere" });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "retired" }, deps);

    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: "retired" },
        pin: undefined,
      },
    ]);
    expect(announcements).toEqual([{ serverId: SERVER_ID, agentId: "elsewhere" }]);
  });

  it("says nothing for an agent that never moved", () => {
    const { deps, announcements } = createFakeNavigators({ agentWorkspaceId: WORKSPACE_ID });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID }, deps);

    expect(announcements).toEqual([]);
  });
});
