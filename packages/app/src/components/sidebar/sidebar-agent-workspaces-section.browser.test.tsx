import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { ToastProvider } from "@/contexts/toast-context";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection, type SidebarProjectionInput } from "./sidebar-projection";
import { AGENT_WORKSPACES_GROUP_KEY } from "./sidebar-labels";
import type { SidebarStatusWorkspaceList as SidebarStatusWorkspaceListType } from "./sidebar-status-list";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 420;

// A couple of files reached through this tree (not this test's code) hold a module-scope JSX
// constant, evaluated once at import time rather than inside a component — unusual, but it means
// the global `React` the classic JSX transform's output expects has to exist before that
// evaluation happens. `vi.stubGlobal` in `beforeEach` runs too late for a *static* import (the
// whole module graph evaluates before this file's own top-level code does), so the component is
// loaded dynamically here, after the global is set.
(globalThis as unknown as { React?: typeof React }).React = React;
let SidebarStatusWorkspaceList: typeof SidebarStatusWorkspaceListType;
beforeAll(async () => {
  ({ SidebarStatusWorkspaceList } = await import("./sidebar-status-list"));
});

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => layout.compact,
}));

const pathnameState = vi.hoisted(() => ({ value: "/" }));
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), dismissTo: vi.fn() },
  useLocalSearchParams: () => ({}),
  usePathname: () => pathnameState.value,
}));

// Pulled in transitively (not by anything this test renders); its top-level code calls the
// native-module stub eagerly rather than lazily, which throws by design. No asset actually loads
// in a static layout screenshot either way.
vi.mock("expo-asset", () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => undefined, localUri: null }) },
}));

// A module-scope JSX constant (not this test's code) trips the browser project's esbuild
// transform before any per-test setup runs. The menu item is Electron-only and renders nothing
// here either way (not Electron), so it is a safe no-op stub for this test alone.
vi.mock("@/workspace/open-in-file-manager/menu-item", () => ({
  OpenInFileManagerMenuItem: () => null,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  layout.compact = false;
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode, width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.style.margin = "0";
  document.body.style.width = `${width}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const NOOP = () => undefined;
const SERVER_ID = "fx-host";
const PROJECT_VIEW_KEY = "acme-mobile";
const EMPTY_ICON_MAP = new Map<string, string | null>();
const EMPTY_SHORTCUT_MAP = new Map<string, number>();
const EMPTY_BADGE_MAP = new Map();
const SUPPORTS_PINNING_MAP = new Map([[SERVER_ID, true]]);

// Fake names and paths only — no real user data.
function fixtureWorkspace(input: {
  id: string;
  name: string;
  statusBucket: SidebarWorkspaceEntry["statusBucket"];
  createdBy?: SidebarWorkspaceEntry["createdBy"];
  pinnedAt?: string | null;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${SERVER_ID}:${input.id}`,
    serverId: SERVER_ID,
    workspaceId: input.id,
    projectViewKey: PROJECT_VIEW_KEY,
    projectName: "Acme Mobile",
    projectRootPath: "/home/fx/acme-mobile",
    workspaceDirectory: `/home/fx/acme-mobile/${input.name}`,
    workspaceDirectoryLabel: input.name,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name,
    title: null,
    pinnedAt: input.pinnedAt ?? null,
    labels: [],
    createdBy: input.createdBy,
    currentBranch: input.name,
    statusBucket: input.statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    diskUsage: null,
  };
}

const PERSON_ENTRIES: SidebarWorkspaceEntry[] = [
  fixtureWorkspace({
    id: "p1",
    name: "release-notes-polish",
    statusBucket: "attention",
    createdBy: "person",
  }),
  fixtureWorkspace({
    id: "p2",
    name: "ios-build-fix",
    statusBucket: "running",
    createdBy: "person",
  }),
  fixtureWorkspace({
    id: "p3",
    name: "onboarding-copy",
    statusBucket: "done",
    createdBy: "person",
  }),
];

const AGENT_ENTRIES: SidebarWorkspaceEntry[] = [
  fixtureWorkspace({
    id: "a1",
    name: "retry-flaky-upload-test",
    statusBucket: "needs_input",
    createdBy: "agent",
  }),
  fixtureWorkspace({
    id: "a2",
    name: "bump-lockfile-deps",
    statusBucket: "done",
    createdBy: "agent",
  }),
  fixtureWorkspace({
    id: "a3",
    name: "prune-stale-branches",
    statusBucket: "done",
    createdBy: "agent",
  }),
];

const PINNED_AGENT_ENTRY = fixtureWorkspace({
  id: "a4",
  name: "investigate-memory-leak",
  statusBucket: "running",
  createdBy: "agent",
  pinnedAt: "2026-10-01T00:00:00.000Z",
});

const ALL_ENTRIES = [...PERSON_ENTRIES, ...AGENT_ENTRIES, PINNED_AGENT_ENTRY];
const ENTRIES_BY_KEY = new Map(ALL_ENTRIES.map((e) => [e.workspaceKey, e]));

function placementOf(source: SidebarWorkspaceEntry): SidebarWorkspacePlacement {
  return {
    workspaceKey: source.workspaceKey,
    serverId: source.serverId,
    workspaceId: source.workspaceId,
    projectViewKey: source.projectViewKey,
    projectName: source.projectName,
    projectKind: source.projectKind,
    workspaceKind: source.workspaceKind,
    name: source.name,
  };
}

const PROJECTS: SidebarProjectEntry[] = [
  {
    viewKey: PROJECT_VIEW_KEY,
    projectName: "Acme Mobile",
    projectKind: "git",
    iconWorkingDir: "/home/fx/acme-mobile",
    hosts: [
      {
        serverId: SERVER_ID,
        projectId: PROJECT_VIEW_KEY,
        iconWorkingDir: "/home/fx/acme-mobile",
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces: ALL_ENTRIES.map(placementOf),
  },
];

const PROJECTION_INPUT: SidebarProjectionInput = {
  projects: PROJECTS,
  pinnedKeys: {
    pinnedWorkspaceKeys: [PINNED_AGENT_ENTRY.workspaceKey],
    pinnedAtByKey: { [PINNED_AGENT_ENTRY.workspaceKey]: "2026-10-01T00:00:00.000Z" },
  },
  pinnedWorkspaceOrder: [],
  workspaceEntriesByKey: ENTRIES_BY_KEY,
  projectNamesByViewKey: new Map([[PROJECT_VIEW_KEY, "Acme Mobile"]]),
  groupMode: "status",
  pinnedCollapsed: false,
  collapsedProjectKeys: new Set(),
  collapsedWorkspaceGroupKeys: new Set(),
};

function AgentSectionHarness({ width }: { width: number }) {
  const projection = React.useMemo(() => buildSidebarProjection(PROJECTION_INPUT), []);
  const pinnedWorkspaces = React.useMemo(
    () =>
      projection.pinnedGroups.pinnedChats.flatMap((placement) => {
        const found = ENTRIES_BY_KEY.get(placement.workspaceKey);
        return found ? [found] : [];
      }),
    [projection],
  );
  const style = React.useMemo(() => ({ width }), [width]);
  return (
    <QueryClientProvider client={queryClient()}>
      <KeyboardActionDispatcherProvider>
        <ToastProvider>
          <div style={style}>
            <SidebarStatusWorkspaceList
              groups={projection.workspaceGroups}
              pinnedWorkspaces={pinnedWorkspaces}
              projectIconByProjectViewKey={EMPTY_ICON_MAP}
              shortcutIndexByWorkspaceKey={EMPTY_SHORTCUT_MAP}
              showShortcutBadges={false}
              hostBadgeByServerId={EMPTY_BADGE_MAP}
              supportsPinningByServerId={SUPPORTS_PINNING_MAP}
              onToggleWorkspacePin={NOOP}
              onPinnedWorkspaceReorder={NOOP}
            />
          </div>
        </ToastProvider>
      </KeyboardActionDispatcherProvider>
    </QueryClientProvider>
  );
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("sidebar: Agent workspaces section", () => {
  it("partitions person, agent-made and manually pinned agent workspaces", () => {
    const projection = buildSidebarProjection(PROJECTION_INPUT);
    const agentGroup = projection.workspaceGroups.find(
      (group) => group.key === AGENT_WORKSPACES_GROUP_KEY,
    );
    expect(agentGroup?.rows.map((row) => row.workspaceId).sort()).toEqual(["a1", "a2", "a3"]);
    expect(agentGroup?.leading).toEqual({ kind: "agent", needsAttention: true });
    expect(projection.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual(["a4"]);
  });

  it.each([
    { name: "collapsed-desktop", width: DESKTOP_WIDTH, compact: false, expanded: false },
    { name: "expanded-desktop", width: DESKTOP_WIDTH, compact: false, expanded: true },
    { name: "collapsed-phone", width: PHONE_WIDTH, compact: true, expanded: false },
    { name: "expanded-phone", width: PHONE_WIDTH, compact: true, expanded: true },
  ])("captures the Agent workspaces section: $name", async ({ name, width, compact, expanded }) => {
    layout.compact = compact;
    useSidebarCollapsedSectionsStore.setState({
      // The agent group's stored key means "explicitly expanded" (default collapsed); every
      // other group's would mean "explicitly collapsed" — see isSidebarWorkspaceGroupCollapsed.
      collapsedWorkspaceGroupKeys: expanded ? new Set([AGENT_WORKSPACES_GROUP_KEY]) : new Set(),
      collapsedProjectKeys: new Set(),
      collapsedPinned: false,
    });
    await page.viewport(width, 1400);
    const container = mount(<AgentSectionHarness width={width} />, width);
    await page.screenshot({
      element: container,
      path: `../../../../../.artifacts/sidebar-agent-section-${name}.png`,
    });
  });
});
