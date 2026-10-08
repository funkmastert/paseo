import type { ReactElement } from "react";
import { MoreVertical, Pencil, Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedWorkflow = withUnistyles(Workflow);
const MENU_ICON_SIZE = 14;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const renameLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const mergeLeading = <ThemedWorkflow size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

export interface KnowledgeNoteMenuProps {
  /** Rename and merge are offered only on `type: project` notes (KTD-11). */
  noteType: string;
  /** Disabled while the note is dirty (an unsaved draft). */
  dirty: boolean;
  onRename: () => void;
  onMerge: () => void;
}

/** The project note header menu (U9, KTD-11): rename and merge, press-opened, never on hover. */
export function KnowledgeNoteMenu({
  noteType,
  dirty,
  onRename,
  onMerge,
}: KnowledgeNoteMenuProps): ReactElement | null {
  const { t } = useTranslation();
  if (noteType !== "project") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={styles.trigger}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("knowledgeBase.note.menu.accessibility")}
        testID="knowledge-note-menu-trigger"
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        <DropdownMenuItem
          leading={renameLeading}
          disabled={dirty}
          onSelect={onRename}
          testID="knowledge-note-menu-rename"
        >
          {t("knowledgeBase.note.menu.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={mergeLeading}
          disabled={dirty}
          onSelect={onMerge}
          testID="knowledge-note-menu-merge"
        >
          {t("knowledgeBase.note.menu.merge")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
}));
