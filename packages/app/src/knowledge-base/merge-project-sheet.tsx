import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KnowledgeBaseMergeCounts } from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  openMergeProjectForm,
  type MergeProjectCandidate,
  type MergeProjectForm,
  type MergeProjectFormSnapshot,
} from "@/knowledge-base/merge-project-form-model";
import { knowledgeBaseErrorMessage } from "@/knowledge-base/rpc-error";
import { useKnowledgeBaseProjectActions } from "@/knowledge-base/use-knowledge-base";

export interface MergeProjectSheetProps {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  snapshot: MergeProjectFormSnapshot;
  onMerged: (target: { path: string; permalink: string; title: string }) => void;
}

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * Merge a project into another (U9, KTD-11): pick the target, review the dry-run counts, confirm
 * destructively. Patterned on `components/project-edit-sheet.tsx` for the sheet shape and
 * `workspace-labels/manager-modal.tsx` for inspect-then-confirm.
 */
export function MergeProjectSheet({
  visible,
  onClose,
  serverId,
  snapshot,
  onMerged,
}: MergeProjectSheetProps): ReactElement {
  const { t } = useTranslation();
  const [form] = useState(() => openMergeProjectForm(snapshot));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const actions = useKnowledgeBaseProjectActions(serverId);
  const { step } = state;

  const pickTarget = useCallback(
    (candidate: MergeProjectCandidate) => {
      void runDryRun(form, actions, candidate);
    },
    [actions, form],
  );
  const retryDryRun = useCallback(() => {
    if (step.kind !== "error") return;
    void runDryRun(form, actions, step.target);
  }, [actions, form, step]);
  const back = useCallback(() => form.back(), [form]);

  const confirmMerge = useCallback(() => {
    if (step.kind !== "ready") return;
    void runMerge(form, actions, step.target, t, () => {
      onMerged(step.target);
      onClose();
    });
  }, [actions, form, onClose, onMerged, step, t]);
  const retryMerge = useCallback(() => {
    if (step.kind !== "mergeFailed") return;
    void runMerge(form, actions, step.target, t, () => {
      onMerged(step.target);
      onClose();
    });
  }, [actions, form, onClose, onMerged, step, t]);

  const busy = step.kind === "counting" || step.kind === "merging";
  const handleClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  const header = useMemo<SheetHeader>(() => ({ title: t("knowledgeBase.merge.title") }), [t]);
  const footer = useMemo(
    () => (
      <MergeSheetFooter
        step={step}
        onCancel={handleClose}
        onBack={back}
        onConfirm={confirmMerge}
        onRetryMerge={retryMerge}
      />
    ),
    [back, confirmMerge, handleClose, retryMerge, step],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      desktopMaxWidth={440}
      sizeContentToCurrentSnapPoint
      testID="knowledge-merge-sheet"
    >
      <MergeSheetBody state={state} onPickTarget={pickTarget} onRetryDryRun={retryDryRun} />
    </AdaptiveModalSheet>
  );
}

async function runDryRun(
  form: MergeProjectForm,
  actions: ReturnType<typeof useKnowledgeBaseProjectActions>,
  target: MergeProjectCandidate,
): Promise<void> {
  form.pickTarget(target);
  try {
    const { moved } = await actions.mergeDryRun({
      sourcePath: form.sourcePath,
      targetPath: target.path,
    });
    form.receiveDryRun(moved);
  } catch (error) {
    form.receiveDryRunError(knowledgeBaseErrorMessage(error));
  }
}

async function runMerge(
  form: MergeProjectForm,
  actions: ReturnType<typeof useKnowledgeBaseProjectActions>,
  target: MergeProjectCandidate,
  t: (key: string, options?: Record<string, unknown>) => string,
  onSuccess: () => void,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: t("knowledgeBase.merge.confirmTitle", {
      source: form.getState().source.title,
      target: target.title,
    }),
    message: t("knowledgeBase.merge.confirmMessage", {
      source: form.getState().source.title,
      target: target.title,
    }),
    confirmLabel: t("knowledgeBase.merge.confirmButton"),
    cancelLabel: t("knowledgeBase.merge.cancel"),
    destructive: true,
  });
  if (!confirmed) return;
  form.startMerging();
  try {
    await actions.merge({ sourcePath: form.sourcePath, targetPath: target.path });
    onSuccess();
  } catch (error) {
    form.receiveMergeError(knowledgeBaseErrorMessage(error));
  }
}

function MergeSheetBody({
  state,
  onPickTarget,
  onRetryDryRun,
}: {
  state: ReturnType<MergeProjectForm["getState"]>;
  onPickTarget: (candidate: MergeProjectCandidate) => void;
  onRetryDryRun: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { step, candidates } = state;
  if (step.kind === "pick") {
    if (candidates.length === 0) {
      return (
        <View style={styles.centered}>
          <Text style={styles.muted}>{t("knowledgeBase.merge.noOtherProjects")}</Text>
        </View>
      );
    }
    return (
      <View testID="knowledge-merge-candidates">
        {candidates.map((candidate) => (
          <CandidateRow key={candidate.path} candidate={candidate} onPress={onPickTarget} />
        ))}
      </View>
    );
  }
  if (step.kind === "counting") {
    return (
      <View style={styles.centered}>
        <ThemedSpinner size="large" />
      </View>
    );
  }
  if (step.kind === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{step.message}</Text>
        <Button variant="outline" size="sm" onPress={onRetryDryRun}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  // "ready", "merging", and "mergeFailed" all show the dry-run counts; only the footer and a
  // trailing status line change.
  return (
    <View testID="knowledge-merge-review">
      <Text style={styles.reviewTitle}>
        {t("knowledgeBase.merge.reviewTitle")} {state.source.title} → {step.target.title}
      </Text>
      <CountsList counts={step.counts} />
      {step.kind === "merging" ? (
        <View style={styles.centered}>
          <ThemedSpinner size="small" />
          <Text style={styles.muted}>{t("knowledgeBase.merge.merging")}</Text>
        </View>
      ) : null}
      {step.kind === "mergeFailed" ? <Text style={styles.errorText}>{step.message}</Text> : null}
    </View>
  );
}

function CandidateRow({
  candidate,
  onPress,
}: {
  candidate: MergeProjectCandidate;
  onPress: (candidate: MergeProjectCandidate) => void;
}): ReactElement {
  const handlePress = useCallback(() => onPress(candidate), [candidate, onPress]);
  return (
    <Pressable
      style={styles.candidateRow}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={candidate.title}
      testID={`knowledge-merge-candidate-${candidate.path}`}
    >
      <Text style={styles.candidateTitle} numberOfLines={1}>
        {candidate.title}
      </Text>
    </Pressable>
  );
}

function CountsList({ counts }: { counts: KnowledgeBaseMergeCounts }): ReactElement {
  const { t } = useTranslation();
  const rows: Array<[string, number]> = [
    [t("knowledgeBase.merge.counts.links"), counts.links],
    [t("knowledgeBase.merge.counts.decisions"), counts.decisions],
    [t("knowledgeBase.merge.counts.rules"), counts.rules],
    [t("knowledgeBase.merge.counts.agents"), counts.agents],
    [t("knowledgeBase.merge.counts.workspaces"), counts.workspaces],
  ];
  return (
    <View style={styles.counts} testID="knowledge-merge-counts">
      {rows.map(([label, count]) => (
        <View style={styles.countRow} key={label}>
          <Text style={styles.countLabel}>{label}</Text>
          <Text style={styles.countValue}>{count}</Text>
        </View>
      ))}
    </View>
  );
}

function MergeSheetFooter({
  step,
  onCancel,
  onBack,
  onConfirm,
  onRetryMerge,
}: {
  step: ReturnType<MergeProjectForm["getState"]>["step"];
  onCancel: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onRetryMerge: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (step.kind === "pick" || step.kind === "counting") {
    return (
      <View style={styles.footer}>
        <Button
          variant="secondary"
          size="md"
          style={styles.footerButton}
          onPress={onCancel}
          disabled={step.kind === "counting"}
        >
          {t("knowledgeBase.merge.cancel")}
        </Button>
      </View>
    );
  }
  if (step.kind === "mergeFailed") {
    return (
      <View style={styles.footer}>
        <Button variant="secondary" size="md" style={styles.footerButton} onPress={onBack}>
          {t("knowledgeBase.merge.back")}
        </Button>
        <Button
          variant="default"
          size="md"
          style={styles.footerButton}
          onPress={onRetryMerge}
          testID="knowledge-merge-confirm"
        >
          {t("knowledgeBase.merge.confirmButton")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.footer}>
      <Button
        variant="secondary"
        size="md"
        style={styles.footerButton}
        onPress={onBack}
        disabled={step.kind === "merging"}
      >
        {t("knowledgeBase.merge.back")}
      </Button>
      <Button
        variant="default"
        size="md"
        style={styles.footerButton}
        onPress={onConfirm}
        disabled={step.kind !== "ready"}
        loading={step.kind === "merging"}
        testID="knowledge-merge-confirm"
      >
        {t("knowledgeBase.merge.confirmButton")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  candidateRow: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  candidateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  reviewTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[3],
  },
  counts: {
    gap: theme.spacing[1],
  },
  countRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[1],
  },
  countLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  countValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
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
