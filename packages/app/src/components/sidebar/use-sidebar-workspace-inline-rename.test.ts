// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarWorkspaceInlineRename } from "./use-sidebar-workspace-inline-rename";

describe("useSidebarWorkspaceInlineRename", () => {
  it("a press on an unselected row calls onPress and never edits", () => {
    const onPress = vi.fn();
    const { result } = renderHook(() =>
      useSidebarWorkspaceInlineRename({ selected: false, onPress }),
    );

    act(() => result.current.handlePress());

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(result.current.isEditing).toBe(false);
  });

  it("a press on the already-selected row enters editing instead of calling onPress again", () => {
    const onPress = vi.fn();
    const { result } = renderHook(() =>
      useSidebarWorkspaceInlineRename({ selected: true, onPress }),
    );

    act(() => result.current.handlePress());

    expect(onPress).not.toHaveBeenCalled();
    expect(result.current.isEditing).toBe(true);
  });

  it("a press while already editing falls through to onPress (e.g. a second click during typing)", () => {
    const onPress = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: boolean }) =>
        useSidebarWorkspaceInlineRename({ selected, onPress }),
      { initialProps: { selected: true } },
    );

    act(() => result.current.handlePress());
    expect(result.current.isEditing).toBe(true);

    rerender({ selected: true });
    act(() => result.current.handlePress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("stopEditing returns to the non-editing state", () => {
    const onPress = vi.fn();
    const { result } = renderHook(() =>
      useSidebarWorkspaceInlineRename({ selected: true, onPress }),
    );

    act(() => result.current.handlePress());
    expect(result.current.isEditing).toBe(true);

    act(() => result.current.stopEditing());
    expect(result.current.isEditing).toBe(false);
  });
});
