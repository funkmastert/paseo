import { useCallback, useState } from "react";

/**
 * The Finder "click the selected item's name again" gesture for a sidebar workspace row: a first
 * press on an unselected row still just selects/navigates; a press on the already-active row
 * enters inline rename instead of re-navigating (which was a no-op anyway).
 */
export function useSidebarWorkspaceInlineRename(input: {
  selected: boolean;
  onPress: () => void;
}): { isEditing: boolean; handlePress: () => void; stopEditing: () => void } {
  const { selected, onPress } = input;
  const [isEditing, setIsEditing] = useState(false);

  const handlePress = useCallback(() => {
    if (selected && !isEditing) {
      setIsEditing(true);
      return;
    }
    onPress();
  }, [selected, isEditing, onPress]);

  const stopEditing = useCallback(() => setIsEditing(false), []);

  return { isEditing, handlePress, stopEditing };
}
