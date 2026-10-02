import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentMoveNoticeStore } from "@/stores/agent-move-notice-store";
import { useSessionStore } from "@/stores/session-store";
import { decideAgentMoveNotice, heldAgentLookup } from "@/utils/agent-migration";

const NOTICE_DURATION_MS = 4000;

/**
 * The one-line "Moved to <account>" note raised when the app shows a moved conversation's live end
 * instead of the handle account failover retired. A toast: it never blocks and it fades.
 */
export function AgentMoveNoticeToast() {
  const { t } = useTranslation();
  const toast = useToast();
  const notice = useAgentMoveNoticeStore((state) => state.notice);
  const agent = useSessionStore((state) =>
    notice ? (heldAgentLookup(state.sessions[notice.serverId])(notice.agentId) ?? null) : null,
  );
  const { entries, isLoading } = useProvidersSnapshot(notice?.serverId ?? null, {
    enabled: notice !== null,
  });
  const shownNoticeIdRef = useRef<number | null>(null);

  useEffect(() => {
    const decision = decideAgentMoveNotice({
      notice,
      shownNoticeId: shownNoticeIdRef.current,
      agent,
      providerEntries: entries,
      providersLoading: isLoading,
    });
    if (decision.kind !== "show") {
      return;
    }
    shownNoticeIdRef.current = decision.noticeId;
    const { target } = decision;
    toast.show(
      target.kind === "account"
        ? t("agentPanel.moved.toAccount", { account: target.label })
        : t("agentPanel.moved.toAgent", { agentId: target.agentId }),
      { variant: "info", durationMs: NOTICE_DURATION_MS, testID: "agent-move-notice" },
    );
  }, [agent, entries, isLoading, notice, t, toast]);

  return null;
}
