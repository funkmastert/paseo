import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  KnowledgeBaseBacklink,
  KnowledgeBaseNoteSummary,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { FileConflictAlert, type FileConflictAlertState } from "@/file-pane/conflict-alert";
import type { FileConflictCallout } from "@/file-pane/editor/model";
import { askKnowledgeLeaveDecision, type KnowledgeLeaveGuard } from "@/knowledge-base/leave-guard";
import { KnowledgeNoteEditor, type KnowledgeNoteRead } from "@/knowledge-base/note-editor-model";
import { KnowledgeNoteMarkdown } from "@/knowledge-base/note-markdown";
import { useKnowledgeLeaveBlockers } from "@/knowledge-base/use-leave-blockers";
import {
  useKnowledgeBaseNote,
  useKnowledgeNoteEditorBackend,
  type KnowledgeBaseNote,
  type KnowledgeNoteLoadState,
  type KnowledgeNoteResult,
} from "@/knowledge-base/use-knowledge-base";
import { KnowledgeNoteEditorSurface } from "./knowledge-note-editor";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export type KnowledgeNoteLayout = "compact" | "pane";

export interface KnowledgeNoteScreenProps {
  serverId: string;
  path: string;
  /** Every note, for resolving `[[wiki links]]`. */
  notes: readonly KnowledgeBaseNoteSummary[];
  /** Compact pushes the note full screen with a back header; pane sits beside the list. */
  layout: KnowledgeNoteLayout;
  guard: KnowledgeLeaveGuard;
  onOpenNote: (path: string) => void;
  onBack: () => void;
}

/** One note: read it, follow its links and backlinks, or edit the whole file. */
export function KnowledgeNoteScreen({
  serverId,
  path,
  notes,
  layout,
  guard,
  onOpenNote,
  onBack,
}: KnowledgeNoteScreenProps): ReactElement {
  const { t } = useTranslation();
  const { state, refetch } = useKnowledgeBaseNote(serverId, path, true);
  const result = state.kind === "loaded" ? state.result : null;
  const [editing, setEditing] = useState<KnowledgeBaseNote | null>(null);
  const stopEditing = useCallback(() => setEditing(null), []);
  const startEditing = useCallback(() => {
    if (result?.status === "ready") setEditing(result.note);
  }, [result]);

  if (editing) {
    return (
      <KnowledgeNoteEditing
        serverId={serverId}
        initialNote={editing}
        result={result}
        layout={layout}
        guard={guard}
        onBack={onBack}
        onDone={stopEditing}
      />
    );
  }

  const title = result?.status === "ready" ? result.note.title : fileTitle(path);
  return (
    <View style={styles.container} testID="knowledge-note-screen">
      <NoteHeader layout={layout} title={title} onBack={onBack}>
        <Button
          variant="outline"
          size="sm"
          onPress={startEditing}
          disabled={result?.status !== "ready"}
          testID="knowledge-note-edit"
        >
          {t("knowledgeBase.note.edit")}
        </Button>
      </NoteHeader>
      <NoteReadBody
        state={state}
        notes={notes}
        onOpenNote={onOpenNote}
        onRetry={refetch}
        onBack={onBack}
      />
    </View>
  );
}

function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

interface NoteHeaderProps {
  layout: KnowledgeNoteLayout;
  title: string;
  onBack: () => void;
  /** The header's actions; the note menu joins them here. */
  children: ReactNode;
}

function NoteHeader({ layout, title, onBack, children }: NoteHeaderProps): ReactElement {
  const actions = useMemo(() => <View style={styles.headerActions}>{children}</View>, [children]);
  const titleNode = useMemo(
    () => <ScreenTitle testID="knowledge-note-title">{title}</ScreenTitle>,
    [title],
  );
  if (layout === "compact") {
    return <BackHeader title={title} onBack={onBack} rightContent={actions} />;
  }
  return <ScreenHeader left={titleNode} right={actions} />;
}

interface NoteReadBodyProps {
  state: KnowledgeNoteLoadState;
  notes: readonly KnowledgeBaseNoteSummary[];
  onOpenNote: (path: string) => void;
  onRetry: () => void;
  onBack: () => void;
}

function NoteReadBody({
  state,
  notes,
  onOpenNote,
  onRetry,
  onBack,
}: NoteReadBodyProps): ReactElement {
  const { t } = useTranslation();
  if (state.kind === "loading") {
    return (
      <View style={styles.centered} testID="knowledge-note-loading">
        <ThemedLoadingSpinner size="large" />
      </View>
    );
  }
  if (state.kind === "error") {
    return (
      <View style={styles.centered} testID="knowledge-note-error">
        <Text style={styles.errorText}>
          {t("knowledgeBase.note.loadFailed", { message: state.message })}
        </Text>
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  if (state.result.status === "missing") {
    return (
      <View style={styles.centered} testID="knowledge-note-not-found">
        <Text style={styles.mutedText}>{t("knowledgeBase.note.notFound")}</Text>
        <Button variant="ghost" size="sm" onPress={onBack}>
          {t("knowledgeBase.note.backToList")}
        </Button>
      </View>
    );
  }
  const { note } = state.result;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <KnowledgeNoteMarkdown content={note.content} notes={notes} onOpenNote={onOpenNote} />
      <NoteBacklinks backlinks={note.backlinks} onOpenNote={onOpenNote} />
    </ScrollView>
  );
}

function NoteBacklinks({
  backlinks,
  onOpenNote,
}: {
  backlinks: readonly KnowledgeBaseBacklink[];
  onOpenNote: (path: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (backlinks.length === 0) return null;
  return (
    <View style={styles.backlinksGutter} testID="knowledge-note-backlinks">
      <View style={styles.backlinksFrame}>
        <Text style={styles.sectionLabel}>{t("knowledgeBase.note.backlinks")}</Text>
        {backlinks.map((backlink) => (
          <BacklinkRow key={backlink.path} backlink={backlink} onOpenNote={onOpenNote} />
        ))}
      </View>
    </View>
  );
}

function BacklinkRow({
  backlink,
  onOpenNote,
}: {
  backlink: KnowledgeBaseBacklink;
  onOpenNote: (path: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onOpenNote(backlink.path), [backlink.path, onOpenNote]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.backlinkRow,
      Boolean(hovered) && styles.backlinkRowHovered,
      pressed && styles.backlinkRowPressed,
    ],
    [],
  );
  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={backlink.title}
    >
      <Text style={styles.backlinkTitle} numberOfLines={1}>
        {backlink.title}
      </Text>
    </Pressable>
  );
}

interface KnowledgeNoteEditingProps {
  serverId: string;
  initialNote: KnowledgeBaseNote;
  /** The open note's latest poll, fed to the editor so a change on disk becomes a conflict. */
  result: KnowledgeNoteResult | null;
  layout: KnowledgeNoteLayout;
  guard: KnowledgeLeaveGuard;
  onBack: () => void;
  onDone: () => void;
}

function KnowledgeNoteEditing({
  serverId,
  initialNote,
  result,
  layout,
  guard,
  onBack,
  onDone,
}: KnowledgeNoteEditingProps): ReactElement {
  const { t } = useTranslation();
  const backend = useKnowledgeNoteEditorBackend(serverId);
  const [editor] = useState(
    () =>
      new KnowledgeNoteEditor({
        note: {
          path: initialNote.path,
          content: initialNote.content,
          modifiedAt: initialNote.modifiedAt,
        },
        backend,
      }),
  );
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const { file, callout, removedSecretSpans } = snapshot;
  const { title, path } = initialNote;

  useEffect(() => () => editor.dispose(), [editor]);
  useEffect(() => {
    if (result) editor.receiveRead(toRead(result));
  }, [editor, result]);
  useEffect(
    () => guard.register(() => editor.requestLeave(() => askKnowledgeLeaveDecision(title))),
    [editor, guard, title],
  );
  useKnowledgeLeaveBlockers({ isDirty: file.modified, onBack });

  const handleSave = useCallback(() => void editor.save(), [editor]);
  const handleClose = useCallback(() => {
    void (async () => {
      await editor.discard();
      onDone();
    })();
  }, [editor, onDone]);
  const alertState = useMemo(() => conflictAlertState(callout, editor), [callout, editor]);
  const canSave = file.status === "dirty" || file.status === "error";
  const savedNotice = file.status === "clean" && removedSecretSpans !== null;

  return (
    <View style={styles.container} testID="knowledge-note-screen">
      <NoteHeader layout={layout} title={title} onBack={onBack}>
        {savedNotice ? (
          <Text style={styles.savedText} testID="knowledge-note-saved">
            {t("knowledgeBase.note.saved")}
          </Text>
        ) : null}
        <Button variant="ghost" size="sm" onPress={handleClose} testID="knowledge-note-cancel">
          {file.modified ? t("knowledgeBase.note.cancel") : t("knowledgeBase.note.done")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          disabled={!canSave}
          loading={file.status === "saving"}
          testID="knowledge-note-save"
        >
          {file.status === "saving" ? t("knowledgeBase.note.saving") : t("knowledgeBase.note.save")}
        </Button>
      </NoteHeader>
      {alertState ? <FileConflictAlert state={alertState} /> : null}
      {file.status === "error" && file.error ? (
        <Text style={styles.saveError} testID="knowledge-note-save-error">
          {t("knowledgeBase.note.saveFailed", { message: file.error })}
        </Text>
      ) : null}
      {removedSecretSpans ? (
        <View style={styles.notice}>
          <Alert
            variant="info"
            title={t("knowledgeBase.note.removedSecrets", { count: removedSecretSpans })}
            testID="knowledge-note-scrubbed"
          />
        </View>
      ) : null}
      <KnowledgeNoteEditorSurface editor={editor} path={path} />
    </View>
  );
}

function toRead(result: KnowledgeNoteResult): KnowledgeNoteRead {
  if (result.status === "missing") return result;
  return { status: "ready", content: result.note.content, modifiedAt: result.note.modifiedAt };
}

function conflictAlertState(
  callout: FileConflictCallout | null,
  editor: KnowledgeNoteEditor,
): FileConflictAlertState | null {
  if (!callout) return null;
  switch (callout.kind) {
    case "changed":
      return {
        kind: "changed",
        canOverwrite: callout.canOverwrite,
        onReload: () => void editor.reload(),
        onOverwrite: () => void editor.overwrite(),
      };
    case "deleted":
      return { kind: "deleted" };
    case "checkFailed":
      return { kind: "checkFailed", retrying: false, onRetry: () => void editor.reload() };
  }
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: theme.spacing[12],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  backlinksGutter: {
    width: "100%",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  backlinksFrame: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[1],
  },
  backlinkRow: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  backlinkRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  backlinkRowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  backlinkTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  savedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  saveError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  notice: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
}));
