import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useWorkspaceRename, type RenamableWorkspace } from "@/hooks/use-workspace-rename";

// Re-exported for callers that imported it from here before it moved next to the shared mutation.
export type { RenamableWorkspace };

export interface WorkspaceRenameModalProps {
  visible: boolean;
  workspace: RenamableWorkspace;
  onClose: () => void;
  /**
   * Prefix for the modal's testIDs. The sidebar callers must keep passing
   * `sidebar-workspace-rename-modal-${workspaceKey}` — e2e/browser/sidebar-workspace-rename.spec.ts
   * builds its locators from exactly that prefix.
   */
  testID?: string;
}

/**
 * Owns the setWorkspaceTitle mutation and every rename string, so a caller only tracks its own
 * open/closed boolean. Errors surface inline inside AdaptiveRenameModal; the dialog stays open.
 */
export function WorkspaceRenameModal({
  visible,
  workspace,
  onClose,
  testID,
}: WorkspaceRenameModalProps) {
  const { t } = useTranslation();
  const { rename } = useWorkspaceRename(workspace);

  const handleSubmit = useCallback(
    async (value: string) => {
      await rename(value);
    },
    [rename],
  );

  return (
    <AdaptiveRenameModal
      visible={visible}
      title={t("sidebar.workspace.rename.title")}
      initialValue={workspace.title ?? workspace.name}
      placeholder={workspace.name}
      submitLabel={t("sidebar.workspace.rename.submit")}
      // Clearing the name restores the branch/directory name shown in the placeholder,
      // and hands naming back to Paseo — see docs/agent-lifecycle.md "Workspace names".
      allowEmpty
      onClose={onClose}
      onSubmit={handleSubmit}
      testID={testID}
    />
  );
}
