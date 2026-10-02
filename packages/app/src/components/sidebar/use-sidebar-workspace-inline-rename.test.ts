// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INLINE_RENAME_DOUBLE_CLICK_MS,
  useSidebarWorkspaceInlineRename,
} from "./use-sidebar-workspace-inline-rename";

function click(detail = 1) {
  return { nativeEvent: { detail } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A row that has been the active one for a while, so a click on it is a deliberate second click. */
function renderSettledSelectedRow(onPress: () => void) {
  const rendered = renderHook(
    ({ selected }: { selected: boolean }) => useSidebarWorkspaceInlineRename({ selected, onPress }),
    { initialProps: { selected: true } },
  );
  act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS * 3));
  return rendered;
}

describe("useSidebarWorkspaceInlineRename", () => {
  it("a press on an unselected row calls onPress and never edits", () => {
    const onPress = vi.fn();
    const { result } = renderHook(() =>
      useSidebarWorkspaceInlineRename({ selected: false, onPress }),
    );

    act(() => result.current.handlePress(click()));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS * 2));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(result.current.isEditing).toBe(false);
  });

  it("a single click on the settled active row enters editing once the double-click window passes", () => {
    const onPress = vi.fn();
    const { result } = renderSettledSelectedRow(onPress);

    act(() => result.current.handlePress(click()));
    expect(result.current.isEditing).toBe(false);
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS));

    expect(onPress).not.toHaveBeenCalled();
    expect(result.current.isEditing).toBe(true);
  });

  it("double-clicking a row to open it never lands in edit", () => {
    const onPress = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: boolean }) =>
        useSidebarWorkspaceInlineRename({ selected, onPress }),
      { initialProps: { selected: false } },
    );

    // First click opens the row, which makes it the selected one.
    act(() => result.current.handlePress(click(1)));
    rerender({ selected: true });
    // The second click of the double-click arrives a moment later.
    act(() => vi.advanceTimersByTime(150));
    act(() => result.current.handlePress(click(2)));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS * 2));

    expect(result.current.isEditing).toBe(false);
  });

  it("a press soon after the row became selected opens rather than edits", () => {
    const onPress = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }: { selected: boolean }) =>
        useSidebarWorkspaceInlineRename({ selected, onPress }),
      { initialProps: { selected: false } },
    );
    rerender({ selected: true });
    act(() => vi.advanceTimersByTime(100));

    act(() => result.current.handlePress(click(1)));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS * 2));

    expect(result.current.isEditing).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("a double-click on the settled active row does not edit either", () => {
    const onPress = vi.fn();
    const { result } = renderSettledSelectedRow(onPress);

    act(() => result.current.handlePress(click(1)));
    act(() => vi.advanceTimersByTime(120));
    act(() => result.current.handlePress(click(2)));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS * 2));

    expect(result.current.isEditing).toBe(false);
  });

  it("a press while already editing falls through to onPress", () => {
    const onPress = vi.fn();
    const { result } = renderSettledSelectedRow(onPress);

    act(() => result.current.handlePress(click()));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS));
    expect(result.current.isEditing).toBe(true);

    act(() => result.current.handlePress(click()));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("stopEditing returns to the non-editing state", () => {
    const onPress = vi.fn();
    const { result } = renderSettledSelectedRow(onPress);

    act(() => result.current.handlePress(click()));
    act(() => vi.advanceTimersByTime(INLINE_RENAME_DOUBLE_CLICK_MS));
    act(() => result.current.stopEditing());

    expect(result.current.isEditing).toBe(false);
  });
});
