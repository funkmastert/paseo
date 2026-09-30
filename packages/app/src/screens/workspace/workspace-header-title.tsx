import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { ScreenTitle } from "@/components/headers/screen-title";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useWorkspaceRename, type RenamableWorkspace } from "@/hooks/use-workspace-rename";
import { useToast } from "@/contexts/toast-context";

export interface EditableWorkspaceHeaderTitleProps {
  /** The resolved label to show while not editing: `workspace.title ?? <fallback>`. */
  title: string;
  /** Null while the workspace descriptor hasn't loaded — the title renders, editing is disabled. */
  workspace: RenamableWorkspace | null;
  testID?: string;
}

/**
 * Tap-to-edit workspace name in the workspace view's header (docs: "session names", Part A). Saves
 * through the same `setWorkspaceTitle` path the rename modal and the sidebar row use — clearing
 * the field hands naming back to Paseo, exactly like the modal's `allowEmpty`.
 */
export function EditableWorkspaceHeaderTitle({
  title,
  workspace,
  testID,
}: EditableWorkspaceHeaderTitleProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const draftRef = useRef(title);
  const { rename } = useWorkspaceRename(
    workspace ?? { serverId: "", workspaceId: "", name: title, title: null },
  );

  const startEditing = useCallback(() => {
    if (!workspace) return;
    draftRef.current = workspace.title ?? "";
    setIsEditing(true);
  }, [workspace]);

  useEffect(() => {
    if (!isEditing) return;
    const raw = draftRef.current;
    const timeout = setTimeout(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      if (raw.length > 0) node.replaceText(raw, { start: 0, end: raw.length });
    }, 0);
    return () => clearTimeout(timeout);
  }, [isEditing]);

  const handleChangeText = useCallback((value: string) => {
    draftRef.current = value;
  }, []);

  const commit = useCallback(() => {
    if (!isEditing || !workspace) return;
    setIsEditing(false);
    const trimmed = draftRef.current.trim();
    if (trimmed === (workspace.title ?? "")) return;
    rename(trimmed).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    });
  }, [isEditing, workspace, rename, toast, t]);

  const cancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === "Escape") cancel();
    },
    [cancel],
  );

  if (isEditing) {
    return (
      <AdaptiveTextInput
        ref={inputRef}
        initialValue={draftRef.current}
        onChangeText={handleChangeText}
        onSubmitEditing={commit}
        onBlur={commit}
        onKeyPress={handleKeyPress}
        placeholder={t("sidebar.workspace.rename.autoPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
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
