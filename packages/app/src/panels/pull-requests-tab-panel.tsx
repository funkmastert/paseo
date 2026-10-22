import { GitPullRequest } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { PullRequestsTabContent } from "@/panels/pull-requests-tab";
import { PullRequestContent, usePullRequestData } from "@/panels/pull-request";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const pullRequestsTabPanelPresentation = {
  label: (t) => t("workspace.tabs.explorerSidebar.prs"),
  subtitle: (t) => t("panels.pullRequests.subtitle"),
  tooltip: (t) => t("workspace.tabs.explorerSidebar.prs"),
  icon: ThemedGitPullRequest,
} satisfies PanelPresentation;
const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

/** A daemon without the ledger RPC can only drive the old single-PR view for this pane. */
function LegacyPullRequestPanel({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const prPane = usePullRequestData({ serverId, cwd });
  if (!cwd) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <PullRequestContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} prPane={prPane} />
  );
}

function PullRequestsTabPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const isOpen = useRetainedPanelActive();
  const supportsLedger = useHostFeature(serverId, "pullRequestLedger");
  if (!supportsLedger) {
    return <LegacyPullRequestPanel serverId={serverId} workspaceId={workspaceId} />;
  }
  return <PullRequestsTabContent serverId={serverId} workspaceId={workspaceId} isOpen={isOpen} />;
}

export const pullRequestsTabPanelRegistration = definePanel("pull_requests", {
  component: PullRequestsTabPanel,
  presentation: pullRequestsTabPanelPresentation,
});
