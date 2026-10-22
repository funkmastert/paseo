import { GitPullRequest } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { PullRequestsTabContent } from "@/panels/pull-requests-tab";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const pullRequestsTabPanelPresentation = {
  label: (t) => t("workspace.tabs.explorerSidebar.prs"),
  subtitle: (t) => t("panels.pullRequests.subtitle"),
  tooltip: (t) => t("workspace.tabs.explorerSidebar.prs"),
  icon: ThemedGitPullRequest,
} satisfies PanelPresentation;

function PullRequestsTabPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const isOpen = useRetainedPanelActive();
  return <PullRequestsTabContent serverId={serverId} workspaceId={workspaceId} isOpen={isOpen} />;
}

export const pullRequestsTabPanelRegistration = definePanel("pull_requests", {
  component: PullRequestsTabPanel,
  presentation: pullRequestsTabPanelPresentation,
});
