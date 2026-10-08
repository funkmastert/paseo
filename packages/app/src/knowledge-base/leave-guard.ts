import { i18n } from "@/i18n/i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { KnowledgeNoteLeaveDecision } from "./note-editor-model";

/**
 * Lets the screen ask the open note whether it may leave before it navigates to another note,
 * follows a wiki link, or goes back. The note's editor registers while it is mounted.
 */
export interface KnowledgeLeaveGuard {
  register(request: () => Promise<boolean>): () => void;
  request(): Promise<boolean>;
}

export function createKnowledgeLeaveGuard(): KnowledgeLeaveGuard {
  let current: (() => Promise<boolean>) | null = null;
  return {
    register(request) {
      current = request;
      return () => {
        if (current === request) current = null;
      };
    },
    request() {
      return current ? current() : Promise.resolve(true);
    },
  };
}

/**
 * Save or Discard, on the shared confirm dialog. Its dismiss path resolves like Cancel, so Save
 * sits on that path: closing the dialog without choosing never loses the draft.
 */
export async function askKnowledgeLeaveDecision(
  title: string,
): Promise<KnowledgeNoteLeaveDecision> {
  const discard = await confirmDialog({
    title: i18n.t("knowledgeBase.leave.title"),
    message: i18n.t("knowledgeBase.leave.message", { title }),
    confirmLabel: i18n.t("knowledgeBase.leave.discard"),
    cancelLabel: i18n.t("knowledgeBase.leave.save"),
    destructive: true,
  });
  return discard ? "discard" : "save";
}
