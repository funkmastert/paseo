import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { FileEditorView } from "@/file-pane/editor/view";
import { useAppSettings } from "@/hooks/use-settings";
import type { KnowledgeNoteEditor } from "@/knowledge-base/note-editor-model";

export interface KnowledgeNoteEditorSurfaceProps {
  editor: KnowledgeNoteEditor;
  path: string;
}

function ignoreCursor(): void {}
function ignoreVimMode(): void {}

/** Desktop and web: the file pane's CodeMirror editor over the note's editor model. */
export function KnowledgeNoteEditorSurface({
  editor,
  path,
}: KnowledgeNoteEditorSurfaceProps): ReactElement {
  const { settings } = useAppSettings();
  const location = useMemo(() => ({ path }), [path]);
  const theme = UnistylesRuntime.getTheme();
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [
      theme.colors.border,
      theme.colors.foreground,
      theme.colors.foregroundMuted,
      theme.colors.surface0,
      theme.colors.syntax,
      theme.colors.terminal.cursor,
      theme.colors.terminal.selectionBackground,
      theme.colorScheme,
      theme.fontFamily.mono,
      theme.fontSize.code,
    ],
  );

  return (
    <View style={styles.container} testID="knowledge-note-editor">
      <FileEditorView
        model={editor.model}
        filename={path}
        location={location}
        navigationRevision={0}
        vimEnabled={settings.vimKeybindings}
        theme={visualTheme}
        onCursorChange={ignoreCursor}
        onVimModeChange={ignoreVimMode}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
});
