import { router, usePathname } from "expo-router";
import { useCallback } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildPinnedGridRoute } from "@/utils/host-routes";

/**
 * What the Pinned section's grid button does. One pinned chat has nothing to tile, so it opens
 * that chat the way a row press does; two or more open the grid route.
 */
export function useOpenPinnedGrid(
  pinned: readonly { serverId: string; workspaceId: string }[],
  /** The compact sidebar closes itself before any navigation it starts. */
  onBeforeOpen?: () => void,
): () => void {
  const pathname = usePathname();
  const only = pinned.length === 1 ? pinned[0] : null;
  const hasPinned = pinned.length > 0;
  return useCallback(() => {
    if (!hasPinned) {
      return;
    }
    onBeforeOpen?.();
    if (only) {
      navigateToWorkspace({ serverId: only.serverId, workspaceId: only.workspaceId });
      return;
    }
    if (!pathname.includes("/pinned-grid")) {
      router.push(buildPinnedGridRoute());
    }
  }, [hasPinned, onBeforeOpen, only, pathname]);
}
