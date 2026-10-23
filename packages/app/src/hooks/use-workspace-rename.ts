import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// The subset of a workspace the rename mutation needs. Narrower than SidebarWorkspaceEntry or
// WorkspaceDescriptor so a caller can build one from whatever it already has in scope.
export interface RenamableWorkspace {
  serverId: string;
  workspaceId: string;
  name: string;
  title?: string | null;
}

export interface UseWorkspaceRenameResult {
  /** Submits a title. An empty (post-trim) value hands naming back to Paseo. */
  rename: (value: string) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

/**
 * The `setWorkspaceTitle` mutation, shared by the rename modal and the inline editors (the
 * workspace header, the active sidebar row). One owner for the empty-hands-back-to-auto rule and
 * the disconnected-host error, so every surface that can rename a workspace does it the same way.
 */
export function useWorkspaceRename(workspace: RenamableWorkspace): UseWorkspaceRenameResult {
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
    },
  });
  const mutateAsync = mutation.mutateAsync;

  const rename = useCallback((value: string) => mutateAsync(value.trim()), [mutateAsync]);

  return { rename, isPending: mutation.isPending, error: mutation.error };
}
