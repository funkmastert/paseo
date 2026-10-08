import { useCallback, useMemo, useState, type ReactElement } from "react";
import { FlatList, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, FolderKanban, Inbox } from "lucide-react-native";
import type {
  KnowledgeBaseNoteSummary,
  KnowledgeBaseSearchResult,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { Theme } from "@/styles/theme";
import {
  knowledgeNoteKind,
  orderKnowledgeNotes,
  resolveKnowledgeSearchView,
  type KnowledgeListRow,
  type KnowledgeNoteKind,
  type KnowledgeSearchView,
} from "./knowledge-list-model";
import { useKnowledgeBaseSearch, type KnowledgeNotesLoadState } from "./use-knowledge-base";

const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_NOTES: readonly KnowledgeBaseNoteSummary[] = [];

const ThemedInbox = withUnistyles(Inbox);
const ThemedFolderKanban = withUnistyles(FolderKanban);
const ThemedFileText = withUnistyles(FileText);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type ListItem =
  | { key: string; kind: "note"; row: KnowledgeListRow }
  | { key: string; kind: "hit"; hit: KnowledgeBaseSearchResult };

interface RowNavigation {
  selectedPath: string | null;
  /** Compact rows push a detail, so they carry the navigation chevron. */
  showChevron: boolean;
  onOpenNote: (path: string) => void;
}

export interface KnowledgeNoteListProps extends RowNavigation {
  serverId: string;
  notes: KnowledgeNotesLoadState;
  onRetry: () => void;
  fullTextSearch: boolean;
}

/** The Inbox, then projects by last update, then other notes, with search over all of them. */
export function KnowledgeNoteList({
  serverId,
  notes,
  onRetry,
  fullTextSearch,
  selectedPath,
  showChevron,
  onOpenNote,
}: KnowledgeNoteListProps): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const loadedNotes = notes.kind === "loaded" ? notes.notes : EMPTY_NOTES;
  const search = useKnowledgeBaseSearch(serverId, searchQuery, fullTextSearch);
  const view = resolveKnowledgeSearchView({
    query: searchQuery,
    fullTextSearch,
    notes: loadedNotes,
    search,
  });

  return (
    <View style={styles.container} testID="knowledge-note-list">
      <View style={styles.searchRail}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("knowledgeBase.list.searchPlaceholder")}
          clearAccessibilityLabel={t("knowledgeBase.list.clearSearch")}
          testID="knowledge-search-input"
          clearTestID="knowledge-search-clear"
        />
      </View>
      <KnowledgeListBody
        view={view}
        notes={notes}
        onRetry={onRetry}
        selectedPath={selectedPath}
        showChevron={showChevron}
        onOpenNote={onOpenNote}
      />
    </View>
  );
}

interface KnowledgeListBodyProps extends RowNavigation {
  view: KnowledgeSearchView;
  notes: KnowledgeNotesLoadState;
  onRetry: () => void;
}

function KnowledgeListBody({
  view,
  notes,
  onRetry,
  ...navigation
}: KnowledgeListBodyProps): ReactElement {
  const { t } = useTranslation();
  const items = useMemo(() => listItemsOf(view, notes), [notes, view]);

  switch (view.kind) {
    case "idle":
      return <KnowledgeNotesState notes={notes} items={items} onRetry={onRetry} {...navigation} />;
    case "pending":
      return (
        <View style={styles.inlineState} testID="knowledge-search-pending">
          <ThemedLoadingSpinner size="small" />
        </View>
      );
    case "results":
      return <KnowledgeRows items={items} {...navigation} />;
    case "title-filter":
      return (
        <View style={styles.container}>
          <Text style={styles.notice} testID="knowledge-search-title-only">
            {t("knowledgeBase.list.titleSearchOnly")}
          </Text>
          <KnowledgeRows items={items} {...navigation} />
        </View>
      );
    case "empty":
      return (
        <View style={styles.inlineState} testID="knowledge-search-empty">
          {view.fullTextUnavailable ? (
            <Text style={styles.notice}>{t("knowledgeBase.list.titleSearchOnly")}</Text>
          ) : null}
          <Text style={styles.mutedText}>{t("knowledgeBase.list.noResults")}</Text>
        </View>
      );
    case "error":
      return (
        <View style={styles.inlineState} testID="knowledge-search-error">
          <Text style={styles.errorText}>
            {t("knowledgeBase.list.searchFailed", { message: view.message })}
          </Text>
        </View>
      );
  }
}

function listItemsOf(view: KnowledgeSearchView, notes: KnowledgeNotesLoadState): ListItem[] {
  if (view.kind === "results") {
    return view.hits.map((hit) => ({ key: hit.path, kind: "hit", hit }));
  }
  if (view.kind === "title-filter") return view.rows.map(noteItem);
  if (view.kind === "idle" && notes.kind === "loaded") {
    return orderKnowledgeNotes(notes.notes).map(noteItem);
  }
  return [];
}

function noteItem(row: KnowledgeListRow): ListItem {
  return { key: row.note.path, kind: "note", row };
}

interface KnowledgeNotesStateProps extends RowNavigation {
  notes: KnowledgeNotesLoadState;
  items: ListItem[];
  onRetry: () => void;
}

function KnowledgeNotesState({
  notes,
  items,
  onRetry,
  ...navigation
}: KnowledgeNotesStateProps): ReactElement {
  const { t } = useTranslation();

  if (notes.kind === "loading") {
    return (
      <View style={styles.centered} testID="knowledge-list-loading">
        <ThemedLoadingSpinner size="large" />
      </View>
    );
  }
  if (notes.kind === "error") {
    return (
      <View style={styles.centered} testID="knowledge-list-error">
        <Text style={styles.errorText}>
          {t("knowledgeBase.list.loadFailed", { message: notes.message })}
        </Text>
        <Button variant="outline" size="sm" onPress={onRetry} testID="knowledge-list-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  if (items.length === 0) {
    return (
      <View style={styles.centered} testID="knowledge-list-empty">
        <Text style={styles.mutedText}>{t("knowledgeBase.list.empty")}</Text>
      </View>
    );
  }
  return <KnowledgeRows items={items} {...navigation} />;
}

interface KnowledgeRowsProps extends RowNavigation {
  items: ListItem[];
}

function KnowledgeRows({
  items,
  selectedPath,
  showChevron,
  onOpenNote,
}: KnowledgeRowsProps): ReactElement {
  const renderItem = useCallback(
    ({ item, index }: { item: ListItem; index: number }) => (
      <KnowledgeRow
        item={item}
        index={index}
        isSelected={pathOf(item) === selectedPath}
        showChevron={showChevron}
        onOpenNote={onOpenNote}
      />
    ),
    [onOpenNote, selectedPath, showChevron],
  );
  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.rows}
      data={items}
      keyExtractor={keyOf}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
    />
  );
}

function keyOf(item: ListItem): string {
  return item.key;
}

function pathOf(item: ListItem): string {
  return item.kind === "note" ? item.row.note.path : item.hit.path;
}

interface KnowledgeRowProps {
  item: ListItem;
  /** Rows are addressed by position in the native smoke flows; paths differ per machine. */
  index: number;
  isSelected: boolean;
  showChevron: boolean;
  onOpenNote: (path: string) => void;
}

function KnowledgeRow({
  item,
  index,
  isSelected,
  showChevron,
  onOpenNote,
}: KnowledgeRowProps): ReactElement {
  const { t } = useTranslation();
  const path = pathOf(item);
  const kind = item.kind === "note" ? item.row.kind : knowledgeNoteKind(item.hit.noteType);
  const title = item.kind === "note" ? item.row.note.title : item.hit.title;
  const detail = item.kind === "note" ? describeNote(item.row, t) : item.hit.snippet;
  const detailLines = item.kind === "hit" ? 2 : 1;
  const handlePress = useCallback(() => onOpenNote(path), [onOpenNote, path]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      isSelected && styles.rowSelected,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isSelected],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={accessibilityState}
      testID={`knowledge-note-row-${index}`}
    >
      <View style={styles.rowIcon}>
        <KindIcon kind={kind} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={detailLines}>
            {detail}
          </Text>
        ) : null}
      </View>
      {showChevron ? <ThemedChevronRight size={16} uniProps={mutedColorMapping} /> : null}
    </Pressable>
  );
}

function KindIcon({ kind }: { kind: KnowledgeNoteKind }): ReactElement {
  switch (kind) {
    case "inbox":
      return <ThemedInbox size={16} uniProps={mutedColorMapping} />;
    case "project":
      return <ThemedFolderKanban size={16} uniProps={mutedColorMapping} />;
    case "note":
      return <ThemedFileText size={16} uniProps={mutedColorMapping} />;
  }
}

function describeNote(row: KnowledgeListRow, t: ReturnType<typeof useTranslation>["t"]): string {
  const links = t("knowledgeBase.list.linkCount", { count: row.note.linkCount });
  if (row.kind === "inbox") return links;
  if (row.kind === "note") return row.note.permalink;
  const decisions = t("knowledgeBase.list.decisionCount", { count: row.note.decisionCount });
  return `${links} · ${decisions}`;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  searchRail: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  rows: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[6],
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowIcon: {
    width: 16,
    alignItems: "center",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  inlineState: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
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
}));
