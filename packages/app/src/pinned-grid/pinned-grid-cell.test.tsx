/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/contexts/toast-context";
import { createSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { usePaneContext } from "@/panels/pane-context";
import { PinnedGridCell } from "@/pinned-grid/pinned-grid-cell";
import type { WorkspaceDescriptor } from "@/stores/session-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: vi.fn(),
}));

const spies = vi.hoisted(() => ({
  navigateToWorkspace: vi.fn(),
  onCardPress: vi.fn(),
}));

const ids = vi.hoisted(() => ({
  SERVER_ID: "server-a",
  AGENT_ID: "agent-1",
}));

vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({
    kind: "agent",
    component: ProbeAgentPanel,
    useDescriptor: vi.fn(),
  }),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: spies.navigateToWorkspace,
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { workspaceTitleSource: "title" } }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    prepareAgentTimeline: () => Promise.resolve(),
  }),
}));

const seenReadOnly: (boolean | undefined)[] = [];

// Stands in for the real agent panel: reads the same pane context a real cell would, and renders
// one nested Pressable so tests can prove clicks on it don't also open the workspace.
function ProbeAgentPanel() {
  const { readOnly } = usePaneContext();
  seenReadOnly.push(readOnly);
  return (
    <Pressable testID="probe-card" onPress={spies.onCardPress}>
      <Text>card</Text>
    </Pressable>
  );
}

const SERVER_ID = ids.SERVER_ID;

function buildWorkspace(): WorkspaceDescriptor {
  return {
    id: "workspace-a",
    projectId: "project-a",
    projectDisplayName: "Project A",
    projectRootPath: "/repo/project-a",
    workspaceDirectory: "/repo/project-a/workspace-a",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

const AGENT_ID = ids.AGENT_ID;

vi.mock("@/stores/session-store", () => ({
  useSessionStore: create(() => ({
    sessions: {
      [ids.SERVER_ID]: {
        agents: new Map([
          [
            ids.AGENT_ID,
            {
              id: ids.AGENT_ID,
              workspaceId: "workspace-a",
              parentAgentId: null,
              archivedAt: null,
              lastActivityAt: new Date("2026-01-01T00:00:00Z"),
              createdAt: new Date("2026-01-01T00:00:00Z"),
            },
          ],
        ]),
        viewedTimelineSync: null,
        hasHydratedAgents: true,
      },
    },
  })),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(): void {
  const workspace = createSidebarWorkspaceEntry({
    serverId: SERVER_ID,
    workspace: buildWorkspace(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ToastProvider>
        <PinnedGridCell workspace={workspace} focused={false} onFocus={vi.fn()} />
      </ToastProvider>,
    );
  });
}

describe("PinnedGridCell", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    seenReadOnly.length = 0;
    spies.navigateToWorkspace.mockClear();
    spies.onCardPress.mockClear();
    vi.restoreAllMocks();
  });

  it("marks the pane content read-only, so the agent panel drops its composer", () => {
    mount();
    expect(seenReadOnly).toEqual([true]);
  });

  it("opens the workspace when the body is clicked outside any card", () => {
    mount();
    const body = container?.querySelector(
      '[data-testid="pinned-grid-cell-body-server-a:workspace-a"]',
    );
    expect(body).toBeTruthy();
    (body as HTMLElement).click();
    expect(spies.navigateToWorkspace).toHaveBeenCalledTimes(1);
    expect(spies.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      workspaceId: "workspace-a",
      target: { kind: "agent", agentId: AGENT_ID },
    });
  });

  it("does not open the workspace when a card inside the body is clicked", () => {
    mount();
    const card = container?.querySelector('[data-testid="probe-card"]');
    expect(card).toBeTruthy();
    (card as HTMLElement).click();
    expect(spies.onCardPress).toHaveBeenCalledTimes(1);
    expect(spies.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("does not open the workspace when the click is the tail end of a text selection", () => {
    mount();
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "selected text",
    } as unknown as Selection);
    const body = container?.querySelector(
      '[data-testid="pinned-grid-cell-body-server-a:workspace-a"]',
    );
    (body as HTMLElement).click();
    expect(spies.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("opens the workspace via the header's explicit open button", () => {
    mount();
    const openButton = container?.querySelector(
      '[data-testid="pinned-grid-open-server-a:workspace-a"]',
    );
    expect(openButton).toBeTruthy();
    (openButton as HTMLElement).click();
    expect(spies.navigateToWorkspace).toHaveBeenCalledTimes(1);
  });
});
