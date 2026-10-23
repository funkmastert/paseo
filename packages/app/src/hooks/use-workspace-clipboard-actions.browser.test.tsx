import React, { act, useCallback, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Clipboard from "expo-clipboard";
import { ToastProvider } from "@/contexts/toast-context";
import {
  useWorkspaceClipboardActions,
  type CopyableWorkspace,
} from "./use-workspace-clipboard-actions";
// Side-effecting: creating the instance is what registers it with react-i18next, so the toast
// renders real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => true),
}));

let mounted: { root: Root; container: HTMLDivElement } | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ToastProvider>{node}</ToastProvider>));
  mounted = { root, container };
  return container;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.mocked(Clipboard.setStringAsync).mockClear();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

function CopyAgentIdButton({ agentId }: { agentId: string | null }) {
  const clipboard = useWorkspaceClipboardActions();
  const workspace: CopyableWorkspace = useMemo(
    () => ({ workspaceId: "ws-1", workspaceDirectory: "/repo", currentBranch: "main", agentId }),
    [agentId],
  );
  const handlePress = useCallback(() => clipboard.copyAgentId(workspace), [clipboard, workspace]);
  return (
    <Pressable testID="copy-agent-id" onPress={handlePress}>
      <Text>Copy ID</Text>
    </Pressable>
  );
}

describe("useWorkspaceClipboardActions copyAgentId", () => {
  it("copies the agent id and shows a toast", async () => {
    const container = mount(<CopyAgentIdButton agentId="agent-123" />);
    const button = container.querySelector('[data-testid="copy-agent-id"]') as HTMLElement;
    await act(async () => {
      button.click();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("agent-123");
    expect(document.body.textContent).toContain("ID copied");
  });

  it("does nothing when the workspace has no agent id", async () => {
    const container = mount(<CopyAgentIdButton agentId={null} />);
    const button = container.querySelector('[data-testid="copy-agent-id"]') as HTMLElement;
    await act(async () => {
      button.click();
    });
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("ID copied");
  });
});
