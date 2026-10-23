import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { View } from "react-native";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { useToast } from "@/contexts/toast-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { menuRowContentInset } from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { createBroadcastPinnedComposerModel } from "./broadcast-pinned-composer-model";
import type { BroadcastSendResult } from "./broadcast-pinned-send";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

const ThemedSend = withUnistyles(Send);

export interface BroadcastPinnedButtonProps {
  targets: BroadcastPinnedTarget[];
  onSend: (text: string, targetIds: string[]) => Promise<BroadcastSendResult>;
}

/**
 * The sidebar's "send to all pinned leaders" button: a popover on wide screens, a bottom sheet
 * on compact ones (the menu engine already owns that split — see docs/menus.md). Renders nothing
 * when there is nothing to broadcast to (R1) and the popover is closed. While the popover is
 * open, it stays mounted even if `targets` drops to zero (every pinned workspace unpinned, every
 * target agent archived) — unmounting mid-session would discard the draft and could tear down a
 * send in flight. The composer shows an empty state and disables sending instead.
 */
export function BroadcastPinnedButton({
  targets,
  onSend,
}: BroadcastPinnedButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  if (targets.length === 0 && !open) {
    return null;
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ToolbarButton
        kind="menu"
        label={t("sidebar.pinned.broadcast")}
        compact={isCompact}
        testID="sidebar-pinned-broadcast"
        tooltipSide="right"
      >
        <ThemedSend
          size={paneContentToolbarIconSize(isCompact)}
          strokeWidth={1.5}
          uniProps={mutedIconColorMapping}
        />
      </ToolbarButton>
      <DropdownMenuContent align="end" width={320} testID="sidebar-pinned-broadcast-content">
        <BroadcastPinnedComposerContent targets={targets} onSend={onSend} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BroadcastPinnedComposerContent({
  targets,
  onSend,
}: BroadcastPinnedButtonProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const closeMenu = useDropdownMenuClose();
  const [model] = useState(() => createBroadcastPinnedComposerModel(targets));
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const [sending, setSending] = useState(false);

  const hasTargets = targets.length > 0;

  const handleSend = useCallback(() => {
    if (!hasTargets || !snapshot.canSend || sending) return;
    const text = snapshot.text;
    const targetIds = [...snapshot.checked];
    setSending(true);
    onSend(text, targetIds)
      .then((result) => {
        if (result.failed.length === 0) {
          toast.show(t("broadcastPinned.sent", { count: result.succeeded.length }));
          closeMenu();
          return;
        }
        toast.error(
          t("broadcastPinned.partialFailure", {
            names: result.failed.map((failure) => failure.target.label).join(", "),
          }),
        );
        return undefined;
      })
      .finally(() => setSending(false));
  }, [closeMenu, hasTargets, onSend, sending, snapshot, t, toast]);

  const handleKeyPress = useCallback(
    (event: {
      nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
    }) => {
      if (!isWeb) return;
      if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
      if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey) return;
      handleSend();
    },
    [handleSend],
  );

  return (
    <>
      <View style={styles.inputWrap}>
        <AdaptiveTextInput
          multiline
          placeholder={t("broadcastPinned.promptPlaceholder")}
          onChangeText={model.setText}
          onKeyPress={handleKeyPress}
          editable={!sending}
          autoFocus
          testID="broadcast-pinned-prompt-input"
        />
      </View>
      <DropdownMenuSeparator />
      {hasTargets ? (
        targets.map((target) => (
          <BroadcastPinnedTargetRow
            key={target.id}
            target={target}
            checked={snapshot.checked.has(target.id)}
            onToggle={model.toggleTarget}
          />
        ))
      ) : (
        <DropdownMenuLabel testID="broadcast-pinned-no-targets">
          {t("broadcastPinned.noTargets")}
        </DropdownMenuLabel>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!hasTargets || !snapshot.canSend || sending}
        status={sending ? "pending" : "idle"}
        closeOnSelect={false}
        onSelect={handleSend}
        testID="broadcast-pinned-send"
      >
        {t("broadcastPinned.sendButton", { count: snapshot.checked.size })}
      </DropdownMenuItem>
    </>
  );
}

function BroadcastPinnedTargetRow({
  target,
  checked,
  onToggle,
}: {
  target: BroadcastPinnedTarget;
  checked: boolean;
  onToggle: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(
    () => <AgentStatusDot status={target.status} requiresAttention={null} />,
    [target.status],
  );
  const handleSelect = useCallback(() => onToggle(target.id), [onToggle, target.id]);
  return (
    <DropdownMenuItem
      leading={leading}
      description={target.agentTitle ?? t("agentList.fallbackTitle")}
      selected={checked}
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`broadcast-pinned-target-${target.id}`}
    >
      {target.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  inputWrap: {
    paddingHorizontal: menuRowContentInset(theme),
    paddingVertical: theme.spacing[2],
  },
}));
