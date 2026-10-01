import { useCallback, useEffect, useRef, useState } from "react";

/** A second click inside this window is a double-click, not a request to rename. */
export const INLINE_RENAME_DOUBLE_CLICK_MS = 400;

/** Just the part of a press event this hook reads; `detail` is the DOM click count on web. */
export interface InlineRenamePressEvent {
  nativeEvent?: unknown;
}

function clickCount(event: InlineRenamePressEvent | undefined): number {
  const detail = (event?.nativeEvent as { detail?: unknown } | undefined)?.detail;
  return typeof detail === "number" && detail > 0 ? detail : 1;
}

/**
 * The Finder "click the selected item's name again" gesture for a sidebar workspace row: a first
 * press on an unselected row still just selects/navigates; a single click on the row that was
 * already active enters inline rename. Like Finder, the edit starts only after the double-click
 * window passes, so double-clicking a row to open it (common on Windows) never lands in edit.
 */
export function useSidebarWorkspaceInlineRename(input: {
  selected: boolean;
  onPress: () => void;
}): {
  isEditing: boolean;
  handlePress: (event?: InlineRenamePressEvent) => void;
  stopEditing: () => void;
} {
  const { selected, onPress } = input;
  const [isEditing, setIsEditing] = useState(false);
  const selectedAtRef = useRef<number | null>(selected ? Date.now() : null);
  const pendingEditRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingEdit = useCallback(() => {
    if (pendingEditRef.current === null) return;
    clearTimeout(pendingEditRef.current);
    pendingEditRef.current = null;
  }, []);

  useEffect(() => {
    if (selected) {
      selectedAtRef.current ??= Date.now();
      return;
    }
    selectedAtRef.current = null;
    cancelPendingEdit();
  }, [selected, cancelPendingEdit]);

  useEffect(() => cancelPendingEdit, [cancelPendingEdit]);

  const handlePress = useCallback(
    (event?: InlineRenamePressEvent) => {
      const wasPending = pendingEditRef.current !== null;
      cancelPendingEdit();
      if (!selected || isEditing) {
        onPress();
        return;
      }
      const selectedAt = selectedAtRef.current ?? Date.now();
      const justSelected = Date.now() - selectedAt < INLINE_RENAME_DOUBLE_CLICK_MS;
      if (wasPending || justSelected || clickCount(event) >= 2) {
        onPress();
        return;
      }
      pendingEditRef.current = setTimeout(() => {
        pendingEditRef.current = null;
        setIsEditing(true);
      }, INLINE_RENAME_DOUBLE_CLICK_MS);
    },
    [selected, isEditing, onPress, cancelPendingEdit],
  );

  const stopEditing = useCallback(() => setIsEditing(false), []);

  return { isEditing, handlePress, stopEditing };
}
