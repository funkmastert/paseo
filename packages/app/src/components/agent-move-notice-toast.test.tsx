/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMoveNoticeToast } from "@/components/agent-move-notice-toast";
import { ToastProvider } from "@/contexts/toast-context";
import { announceAgentMove, useAgentMoveNoticeStore } from "@/stores/agent-move-notice-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));

const providers = vi.hoisted(() => ({
  entries: undefined as { provider: string; label: string; status: "ready" }[] | undefined,
  isLoading: false,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: providers.entries, isLoading: providers.isLoading }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: create(() => ({
    sessions: {
      "server-a": {
        agents: new Map([["successor", { id: "successor", provider: "claude-backup" }]]),
        agentDetails: new Map(),
      },
    },
  })),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ToastProvider>
        <AgentMoveNoticeToast />
      </ToastProvider>,
    );
  });
}

describe("AgentMoveNoticeToast", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    useAgentMoveNoticeStore.setState({ notice: null });
    providers.entries = [
      { provider: "claude-backup", label: "Claude Backup (work)", status: "ready" },
    ];
    providers.isLoading = false;
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
    document.body.innerHTML = "";
  });

  it("names the account the conversation moved to", () => {
    mount();
    act(() => {
      announceAgentMove({ serverId: "server-a", agentId: "successor" });
    });
    expect(document.body.textContent).toContain("agentPanel.moved.toAccount:Claude Backup (work)");
  });

  it("names the agent id when the app does not hold the successor", () => {
    mount();
    act(() => {
      announceAgentMove({ serverId: "server-a", agentId: "not-on-this-host" });
    });
    expect(document.body.textContent).toContain("agentPanel.moved.toAgent:not-on-this-host");
  });

  it("waits for the account labels before naming the account", () => {
    providers.entries = undefined;
    providers.isLoading = true;
    mount();
    act(() => {
      announceAgentMove({ serverId: "server-a", agentId: "successor" });
    });
    expect(document.body.textContent).not.toContain("agentPanel.moved");
  });
});
