import { useCallback, useEffect, useRef } from "react";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useToast } from "@/contexts/toast-context";
import { useWorkspaceRename, type RenamableWorkspace } from "@/hooks/use-workspace-rename";

export interface SidebarWorkspaceInlineTitleFieldProps {
  workspace: RenamableWorkspace;
  /** Called on Enter, blur, or Escape — the row goes back to showing its name `Text`. */
  onDone: () => void;
  testID?: string;
}

/**
 * The active sidebar row's click-to-edit field (Part A, second click on the selected row). Saves
 * through the same `setWorkspaceTitle` path as the rename modal and the header's inline editor.
 */
export function SidebarWorkspaceInlineTitleField({
  workspace,
  onDone,
  testID,
}: SidebarWorkspaceInlineTitleFieldProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const draftRef = useRef(workspace.title ?? "");
  const doneRef = useRef(false);
  const { rename } = useWorkspaceRename(workspace);

  useEffect(() => {
    const raw = draftRef.current;
    const timeout = setTimeout(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      if (raw.length > 0) node.replaceText(raw, { start: 0, end: raw.length });
    }, 0);
    return () => clearTimeout(timeout);
    // Intentionally runs once, on mount: `titleSlot` mounts this field only while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChangeText = useCallback((value: string) => {
    draftRef.current = value;
  }, []);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
    const trimmed = draftRef.current.trim();
    if (trimmed === (workspace.title ?? "")) return;
    rename(trimmed).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    });
  }, [onDone, rename, workspace.title, toast, t]);

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  const handleKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === "Escape") cancel();
    },
    [cancel],
  );

  return (
    <AdaptiveTextInput
      ref={inputRef}
      initialValue={draftRef.current}
      onChangeText={handleChangeText}
      onSubmitEditing={finish}
      onBlur={finish}
      onKeyPress={handleKeyPress}
      placeholder={t("sidebar.workspace.rename.autoPlaceholder")}
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.input}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    flex: 1,
    minWidth: 0,
    padding: 0,
  },
}));
