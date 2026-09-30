/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartRecoveryEntry } from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import type { RestartRecoveryStripModel } from "./model";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const spies = vi.hoisted(() => ({
  navigateToAgent: vi.fn(),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: spies.navigateToAgent,
}));

const desktopState = vi.hoisted(() => ({
  isElectron: false,
  keepRunningAfterQuit: false,
}));

vi.mock("@/constants/platform", () => ({
  getIsElectron: () => desktopState.isElectron,
  isWeb: false,
  isNative: false,
}));

vi.mock("@/desktop/settings/desktop-settings", () => ({
  useDesktopSettings: () => ({
    settings: { daemon: { keepRunningAfterQuit: desktopState.keepRunningAfterQuit } },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: vi.fn(),
  }),
}));

const hookState = vi.hoisted(() => ({
  model: null as RestartRecoveryStripModel | null,
  serverId: "server-a",
}));

vi.mock("./use-restart-recovery", () => ({
  useRestartRecovery: () => ({
    model: hookState.model,
    serverId: hookState.serverId,
    resumeAll: vi.fn(),
    dismissAll: vi.fn(),
    busy: false,
    error: null,
  }),
}));

import { router } from "expo-router";
import { RestartRecoveryStrip } from "./restart-recovery-strip";

function entry(overrides: Partial<RestartRecoveryEntry> = {}): RestartRecoveryEntry {
  return {
    agentId: "agent-1",
    title: "Fix the flaky test",
    provider: "claude",
    cwd: "/repo",
    workspaceId: "workspace-1",
    parentAgentId: null,
    depth: 0,
    runStartedAt: "2026-09-29T19:30:00.000Z",
    stoppedAt: "2026-09-29T20:49:10.000Z",
    readiness: "restorable",
    checks: [],
    state: "pending",
    detail: null,
    resolvedAt: null,
    ...overrides,
  };
}

function buildModel(overrides: Partial<RestartRecoveryStripModel> = {}): RestartRecoveryStripModel {
  return {
    open: [entry()],
    resumableCount: 1,
    mode: "plan",
    reason: "bozeo_quit",
    at: "2026-09-29T20:49:10.000Z",
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<RestartRecoveryStrip />);
  });
}

function expand(): void {
  const toggle = container?.querySelector('[data-testid="restart-recovery-summary-toggle"]');
  act(() => {
    (toggle as HTMLElement).click();
  });
}

describe("RestartRecoveryStrip", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    hookState.model = buildModel();
    hookState.serverId = "server-a";
    desktopState.isElectron = false;
    desktopState.keepRunningAfterQuit = false;
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
    vi.clearAllMocks();
  });

  it("renders nothing when there is no model", () => {
    hookState.model = null;
    mount();
    expect(container?.querySelector('[data-testid="restart-recovery-strip"]')).toBeNull();
  });

  it("pressing a row navigates to that agent", () => {
    mount();
    expand();
    const row = container?.querySelector('[data-testid="restart-recovery-row-agent-1"]');
    expect(row).toBeTruthy();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(spies.navigateToAgent).toHaveBeenCalledWith({
      serverId: "server-a",
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });
  });

  it("shows the reason and age line above the entries", () => {
    mount();
    expand();
    expect(container?.querySelector('[data-testid="restart-recovery-reason"]')?.textContent).toBe(
      "restartRecovery.reason.bozeo_quit",
    );
    expect(container?.querySelector('[data-testid="restart-recovery-age"]')).toBeTruthy();
  });

  it("omits the reason line when the reason is not known", () => {
    hookState.model = buildModel({ reason: null });
    mount();
    expand();
    expect(container?.querySelector('[data-testid="restart-recovery-reason"]')).toBeNull();
  });

  it("shows the keep-running hint only on Electron with the setting off, for a Bozeo-quit reason", () => {
    desktopState.isElectron = true;
    desktopState.keepRunningAfterQuit = false;
    mount();
    expand();
    const hint = container?.querySelector('[data-testid="restart-recovery-keep-running-hint"]');
    expect(hint).toBeTruthy();
    act(() => {
      (hint as HTMLElement).click();
    });
    expect(router.push).toHaveBeenCalledWith("/settings/hosts/server-a");
  });

  it("hides the keep-running hint once the setting is already on", () => {
    desktopState.isElectron = true;
    desktopState.keepRunningAfterQuit = true;
    mount();
    expand();
    expect(
      container?.querySelector('[data-testid="restart-recovery-keep-running-hint"]'),
    ).toBeNull();
  });

  it("hides the keep-running hint off Electron", () => {
    desktopState.isElectron = false;
    mount();
    expand();
    expect(
      container?.querySelector('[data-testid="restart-recovery-keep-running-hint"]'),
    ).toBeNull();
  });

  it("shows the resume-mode hint only in plan mode", () => {
    hookState.model = buildModel({ mode: "plan" });
    mount();
    expand();
    expect(
      container?.querySelector('[data-testid="restart-recovery-resume-mode-hint"]'),
    ).toBeTruthy();
  });

  it("hides the resume-mode hint once the host is in resume mode", () => {
    hookState.model = buildModel({ mode: "resume" });
    mount();
    expand();
    expect(
      container?.querySelector('[data-testid="restart-recovery-resume-mode-hint"]'),
    ).toBeNull();
  });
});
