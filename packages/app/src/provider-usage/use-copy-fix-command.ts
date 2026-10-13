import { useCallback } from "react";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";

/** Copies an account problem's fix command, with a toast either way. */
export function useCopyFixCommand(fixCommand: string): () => void {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(() => {
    void (async () => {
      try {
        await Clipboard.setStringAsync(fixCommand);
        toast.copied(t("panels.orchestration.identityCopied"));
      } catch {
        toast.error(t("panels.orchestration.identityCopyError"));
      }
    })();
  }, [fixCommand, t, toast]);
}
