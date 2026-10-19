import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingScrollView } from "@/components/ui/floating";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildJevDashboardRoute } from "@/utils/host-routes";
import { resolveScrollIndicatorFade } from "@/agent-stream/scroll-indicator-fade";
import { JevDecisionsList } from "./jev-decisions-list";
import { buildJevDecisionsView, type JevDecisionsView } from "./jev-decisions-model";
import { useAgentJevDecisions } from "./use-agent-jev-decisions";

const ThemedGauge = withUnistyles(Gauge);
const LEADING_ICON_SIZE = 12;
const POPOVER_MAX_HEIGHT = 320;

/**
 * How many decisions JEV made for this agent, in the agent header (docs/jev.md, "Feature 11").
 * For a leader this includes its direct children's, so Tyler sees JEV's involvement with a
 * subagent fleet at a glance without opening each one. Hidden when there are none: most agents
 * never have one.
 */
export function JevHeaderBadge({
  serverId,
  agentId,
}: {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
}) {
  const { data } = useAgentJevDecisions(serverId, agentId, { includeChildren: true });
  const view = useMemo(
    () => buildJevDecisionsView(data?.decisions ?? [], data?.status ?? null),
    [data],
  );
  const openAllActivity = useCallback(() => {
    if (!serverId || !agentId) return;
    router.push(buildJevDashboardRoute(serverId, agentId));
  }, [serverId, agentId]);

  const count = data?.decisions.length ?? 0;
  if (count === 0) return null;
  return <JevHeaderBadgeView count={count} view={view} onOpenAllActivity={openAllActivity} />;
}

/**
 * No data source, so a browser test can hand it a view directly (the `JevDecisionsList` pattern).
 * `count` is the total, not `view.lines.length`: the view caps at the popover's shown limit.
 */
export function JevHeaderBadgeView({
  count,
  view,
  onOpenAllActivity,
}: {
  count: number;
  view: JevDecisionsView;
  onOpenAllActivity?: () => void;
}) {
  const { t } = useTranslation();
  const label = t("jevHeaderBadge.label", { count });
  const accessibilityLabel = t("jevHeaderBadge.accessibilityLabel", { count });
  const leadingIcon = useMemo(() => <ThemedGauge size={LEADING_ICON_SIZE} />, []);
  // The badge mounts the first time an agent gets a JEV decision and stays mounted after, so a
  // hard snap-in only ever happens once per agent. Fading it in (same Android-crash workaround as
  // the scroll indicators) reads as an appearance rather than a layout jump. No `exiting`: the
  // badge never unmounts on its own (it only appears), so there is nothing to animate out.
  const { fadeIn } = resolveScrollIndicatorFade();

  // The Animated.View carries no theme-tracked style: Unistyles and Reanimated both mutate the
  // same native node, and patching one that the other owns crashes on a theme change
  // (docs/unistyles.md, "Reanimated Animated.View + Dynamic Styles Crashes"). The themed padding
  // lives one level in, on a plain View Reanimated never touches (status-ring/index.tsx).
  return (
    <Animated.View entering={fadeIn} testID="jev-header-badge">
      <View style={styles.row}>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              hitSlop={4}
              testID="jev-header-badge-trigger"
            >
              <StatusBadge label={label} leading={leadingIcon} />
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" offset={8}>
            <FloatingScrollView style={styles.popoverScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.popoverContent}>
                <JevDecisionsList view={view} onOpenAllActivity={onOpenAllActivity} />
              </View>
            </FloatingScrollView>
          </TooltipContent>
        </Tooltip>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  popoverScroll: {
    maxHeight: POPOVER_MAX_HEIGHT,
  },
  popoverContent: {
    minWidth: 240,
  },
}));
