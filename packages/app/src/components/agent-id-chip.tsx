import { useCallback, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { getAgentShortId } from "@/utils/agent-short-id";

interface AgentIdChipProps {
  agentId: string;
  testID?: string;
}

/**
 * The agent's short id — a fixed-width monospace prefix, tap/click to copy the full id. On web,
 * hovering shows the full id via tooltip; native has no hover, so tap-to-copy is the only path
 * there. Shared by every surface that lists or headers an agent, so the id format and the copy
 * interaction stay identical everywhere (docs/design.md §2).
 */
export function AgentIdChip({ agentId, testID }: AgentIdChipProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const shortId = getAgentShortId(agentId);

  const handleCopy = useCallback(() => {
    void copyToClipboard(agentId);
    toast.copied(t("agentIdChip.copiedLabel"));
  }, [agentId, t, toast]);

  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={handleCopy}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.tabs.menu.copyAgentId")}
          testID={testID}
          style={styles.trigger}
        >
          <Text style={styles.text} numberOfLines={1}>
            {shortId}
          </Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={6}>
        <Text style={styles.tooltipText}>{agentId}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.base,
  },
  text: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
