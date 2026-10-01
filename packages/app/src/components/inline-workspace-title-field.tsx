import { useCallback, useEffect, useRef } from "react";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useToast } from "@/contexts/toast-context";
import { useWorkspaceRename, type RenamableWorkspace } from "@/hooks/use-workspace-rename";

export interface InlineWorkspaceTitleFieldProps {
  workspace: RenamableWorkspace;
  /** Called once on Enter, blur, or Escape — the caller goes back to showing the name. */
  onDone: () => void;
  /** `title` matches the workspace header's `ScreenTitle`; `row` matches a sidebar row's name. */
  variant: "title" | "row";
  testID?: string;
}

/**
 * Click-to-edit workspace name, shared by the workspace header and the active sidebar row. Saves
 * through the same `setWorkspaceTitle` path as the rename modal; an empty value hands naming back
 * to Paseo. Mounted only while editing, so it focuses and selects on mount.
 */
export function InlineWorkspaceTitleField({
  workspace,
  onDone,
  variant,
  testID,
}: InlineWorkspaceTitleFieldProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const draftRef = useRef(workspace.title ?? "");
  // Enter blurs the field and unmounting it can blur it too; only the first ending counts, so
  // Enter saves once and Escape never turns into a save.
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
      style={variant === "title" ? styles.title : styles.row}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Same typography as ScreenTitle, so the name doesn't jump when it turns into a field.
  title: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  row: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    flex: 1,
    minWidth: 0,
    padding: 0,
  },
}));
