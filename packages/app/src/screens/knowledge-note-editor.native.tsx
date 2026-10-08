import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { StyleSheet as NativeStyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import type { KnowledgeNoteEditor } from "@/knowledge-base/note-editor-model";
import type { Theme } from "@/styles/theme";

export interface KnowledgeNoteEditorSurfaceProps {
  editor: KnowledgeNoteEditor;
  path: string;
}

const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

/**
 * iOS and Android: CodeMirror does not run here, so the whole file is a multiline text input
 * (KTD-11). Reload and Discard replace its text through the input's own command.
 */
export function KnowledgeNoteEditorSurface({
  editor,
}: KnowledgeNoteEditorSurfaceProps): ReactElement {
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [initialValue] = useState(() => editor.getSnapshot().file.content);
  const content = snapshot.file.content;
  const { style: keyboardPaddingStyle } = useKeyboardShiftStyle({ mode: "padding" });
  const containerStyle = useMemo(
    () => [layoutStyles.fill, keyboardPaddingStyle],
    [keyboardPaddingStyle],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (input && input.getText() !== content) input.replaceText(content);
  }, [content]);

  const handleChangeText = useCallback((text: string) => editor.edit(text), [editor]);

  return (
    <Animated.View style={containerStyle}>
      <View style={styles.frame} testID="knowledge-note-editor">
        <ThemedTextInput
          ref={inputRef}
          initialValue={initialValue}
          onChangeText={handleChangeText}
          multiline
          scrollEnabled
          textAlignVertical="top"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={snapshot.file.status !== "saving"}
          style={styles.input}
          testID="knowledge-note-editor-input"
        />
      </View>
    </Animated.View>
  );
}

const layoutStyles = NativeStyleSheet.create({
  fill: {
    flex: 1,
    minHeight: 0,
  },
});

const styles = StyleSheet.create((theme) => ({
  frame: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  input: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
}));
