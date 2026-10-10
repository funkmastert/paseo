import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
} from "@/components/ui/context-menu";
import { buildNavigationHistoryReplayDeps } from "@/navigation/navigation-history-replay";
import { goBackTo } from "@/stores/navigation-history-store";
import { useHistoryRecentMenuEntries } from "./use-history-recent-menu-entries";

function HistoryRecentMenuItemRow({
  depth,
  primary,
  secondary,
}: {
  depth: number;
  primary: string;
  secondary?: string;
}) {
  const handleSelect = useCallback(() => {
    goBackTo(depth, buildNavigationHistoryReplayDeps());
  }, [depth]);

  return (
    <ContextMenuItem
      testID={`history-recent-menu-item-${depth}`}
      description={secondary}
      onSelect={handleSelect}
    >
      {primary}
    </ContextMenuItem>
  );
}

/**
 * The recent-history popover/sheet opened by a long press (native) or right click (web/desktop)
 * on the back button -- see docs/plans/2026-09-12-001-feat-global-back-history-plan.md. Rendered
 * as a sibling of `ContextMenuTrigger` inside the same `ContextMenu` root; see
 * `history-back-button.tsx` for the trigger.
 */
export function HistoryRecentMenuContent() {
  const { t } = useTranslation();
  const entries = useHistoryRecentMenuEntries();

  return (
    <ContextMenuContent align="start" width={260} testID="history-recent-menu">
      {entries.length === 0 ? (
        <ContextMenuLabel>{t("workspace.header.history.empty")}</ContextMenuLabel>
      ) : (
        entries.map((item) => <HistoryRecentMenuItemRow key={item.depth} {...item} />)
      )}
    </ContextMenuContent>
  );
}
