import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineWorkspaceTitleField } from "@/components/inline-workspace-title-field";
import { ScreenTitle } from "@/components/headers/screen-title";
import type { RenamableWorkspace } from "@/hooks/use-workspace-rename";

export interface EditableWorkspaceHeaderTitleProps {
  /** The resolved label to show while not editing: `workspace.title ?? <fallback>`. */
  title: string;
  /** Null while the workspace descriptor hasn't loaded — the title renders, editing is disabled. */
  workspace: RenamableWorkspace | null;
  testID?: string;
}

/**
 * Tap-to-edit workspace name in the workspace view's header. The field is the same one the
 * sidebar row uses, so both save through the rename modal's path and clearing hands naming back
 * to Paseo.
 */
export function EditableWorkspaceHeaderTitle({
  title,
  workspace,
  testID,
}: EditableWorkspaceHeaderTitleProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);

  const startEditing = useCallback(() => {
    if (workspace) setIsEditing(true);
  }, [workspace]);
  const stopEditing = useCallback(() => setIsEditing(false), []);

  if (isEditing && workspace) {
    return (
      <InlineWorkspaceTitleField
        workspace={workspace}
        onDone={stopEditing}
        variant="title"
        testID={testID ? `${testID}-input` : undefined}
      />
    );
  }

  return (
    <ScreenTitle
      testID={testID}
      onPress={workspace ? startEditing : undefined}
      accessibilityLabel={t("sidebar.workspace.rename.title")}
    >
      {title}
    </ScreenTitle>
  );
}
