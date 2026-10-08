import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  openRenameProjectForm,
  type RenameProjectFormSnapshot,
} from "@/knowledge-base/rename-project-form-model";
import { knowledgeBaseErrorMessage } from "@/knowledge-base/rpc-error";
import { useKnowledgeBaseProjectActions } from "@/knowledge-base/use-knowledge-base";

export interface RenameProjectSheetProps {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  snapshot: RenameProjectFormSnapshot;
  onRenamed: (result: { path: string; permalink: string; title: string }) => void;
}

/** Rename a project note (U9, KTD-11). Patterned on `components/project-edit-sheet.tsx`. */
export function RenameProjectSheet({
  visible,
  onClose,
  serverId,
  snapshot,
  onRenamed,
}: RenameProjectSheetProps) {
  const { t } = useTranslation();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [form] = useState(() => openRenameProjectForm(snapshot));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const actions = useKnowledgeBaseProjectActions(serverId);

  const mutation = useMutation({
    mutationFn: () => actions.rename(form.submission),
    onSuccess: (result) => {
      onRenamed(result);
      onClose();
    },
    onError: (error) => form.setSubmitError({ message: knowledgeBaseErrorMessage(error) }),
  });
  const isSaving = mutation.isPending;

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [isSaving, onClose]);
  const handleSubmit = useCallback(() => mutation.mutate(), [mutation]);

  const header = useMemo<SheetHeader>(() => ({ title: t("knowledgeBase.rename.title") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="secondary"
          size="md"
          style={styles.footerButton}
          onPress={handleClose}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="md"
          style={styles.footerButton}
          onPress={handleSubmit}
          disabled={!state.canSubmit}
          loading={isSaving}
          testID="knowledge-rename-save"
        >
          {isSaving ? t("knowledgeBase.rename.saving") : t("knowledgeBase.rename.save")}
        </Button>
      </View>
    ),
    [handleClose, handleSubmit, isSaving, state.canSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      desktopMaxWidth={440}
      sizeContentToCurrentSnapPoint
      testID="knowledge-rename-sheet"
    >
      <Field label={t("knowledgeBase.rename.titleLabel")} error={state.error?.message ?? null}>
        <FormTextInput
          size={size}
          testID="knowledge-rename-title"
          accessibilityLabel={t("knowledgeBase.rename.titleLabel")}
          initialValue={state.title}
          onChangeText={form.setTitle}
          editable={!isSaving}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  footerButton: {
    minWidth: 112,
  },
}));
