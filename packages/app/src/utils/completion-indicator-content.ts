import { CircleCheckBig, GitPullRequestArrow } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { CompletionState } from "@getpaseo/protocol/agent-labels";
import type { Theme } from "@/styles/theme";

/**
 * Icon, theme color, i18n label key, testID suffix, and accessibility-label formula for a
 * completion state — shared by every surface that renders the ready-to-merge / done glyph
 * (the workspace row's full-slot indicator and the project row's corner badge) so they can't
 * drift from each other.
 */
export const CompletionIndicatorIcon = {
  "ready-to-merge": withUnistyles(GitPullRequestArrow),
  done: withUnistyles(CircleCheckBig),
};

const readyToMergeColorMapping = (theme: Theme) => ({ color: theme.colors.accent });
const doneColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

export function getCompletionIndicatorColorMapping(completionState: CompletionState) {
  return completionState === "ready-to-merge" ? readyToMergeColorMapping : doneColorMapping;
}

export function getCompletionIndicatorLabelKey(completionState: CompletionState): string {
  return completionState === "ready-to-merge"
    ? "agentList.completion.readyToMerge"
    : "agentList.completion.done";
}

export function getCompletionIndicatorTestIdSuffix(completionState: CompletionState): string {
  return completionState === "ready-to-merge" ? "ready-to-merge" : "completion-done";
}

export function formatCompletionIndicatorAccessibilityLabel(
  label: string,
  completionNote: string | null,
): string {
  return completionNote ? `${label} — ${completionNote}` : label;
}
