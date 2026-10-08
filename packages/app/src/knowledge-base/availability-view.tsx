import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { KnowledgeBaseAvailability, KnowledgeBaseSidecarBanner } from "./availability";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

type BlockedAvailability = Exclude<KnowledgeBaseAvailability, { kind: "ready" }>;

/** Everything the screen shows instead of the list: no host, older host, feature off, errors. */
export function KnowledgeBaseAvailabilityNotice({
  availability,
  onRetry,
}: {
  availability: BlockedAvailability;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  switch (availability.kind) {
    case "no-host":
      return (
        <Alert
          title={t("knowledgeBase.availability.noHostTitle")}
          description={t("knowledgeBase.availability.noHostDescription")}
          testID="knowledge-no-host"
        />
      );
    case "connecting":
      return (
        <Alert title={t("knowledgeBase.availability.connecting")} testID="knowledge-connecting" />
      );
    case "update-host":
      return (
        <Alert
          variant="info"
          title={t("knowledgeBase.availability.updateHostTitle")}
          description={t("knowledgeBase.availability.updateHostDescription")}
          testID="knowledge-update-host"
        />
      );
    case "status-loading":
      return (
        <View style={styles.centered} testID="knowledge-status-loading">
          <ThemedLoadingSpinner size="large" />
        </View>
      );
    case "status-error":
      return (
        <Alert
          variant="error"
          title={t("knowledgeBase.availability.statusError")}
          description={availability.message}
          testID="knowledge-status-error"
        >
          <Button variant="outline" size="sm" onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        </Alert>
      );
    case "disabled":
      return (
        <DisabledNotice setupHint={availability.setupHint} command={availability.setupCommand} />
      );
  }
}

function DisabledNotice({
  setupHint,
  command,
}: {
  setupHint: string | null;
  command: string;
}): ReactElement {
  const { t } = useTranslation();
  const description = useMemo(
    () => (
      <>
        <Text style={styles.description}>
          {t("knowledgeBase.availability.disabledDescription")}
        </Text>
        <Text selectable style={styles.command} testID="knowledge-setup-command">
          {command}
        </Text>
        {setupHint ? <Text style={styles.description}>{setupHint}</Text> : null}
      </>
    ),
    [command, setupHint, t],
  );
  return (
    <Alert
      variant="warning"
      title={t("knowledgeBase.availability.disabledTitle")}
      description={description}
      testID="knowledge-disabled"
    />
  );
}

const BANNER_VARIANT = { missing: "warning", starting: "info", backoff: "warning" } as const;

/** Basic Memory is not running: notes still open and save, search matches titles meanwhile. */
export function KnowledgeBaseSidecarNotice({
  banner,
}: {
  banner: KnowledgeBaseSidecarBanner;
}): ReactElement {
  const { t } = useTranslation();
  const titles = {
    missing: t("knowledgeBase.sidecar.missingTitle"),
    starting: t("knowledgeBase.sidecar.startingTitle"),
    backoff: t("knowledgeBase.sidecar.backoffTitle"),
  };
  const description = useMemo(
    () => (
      <>
        <Text style={styles.description}>{t("knowledgeBase.sidecar.description")}</Text>
        {banner.detail ? (
          <Text selectable style={styles.detail} numberOfLines={3}>
            {banner.detail}
          </Text>
        ) : null}
        {banner.setupCommand ? (
          <Text selectable style={styles.command}>
            {banner.setupCommand}
          </Text>
        ) : null}
      </>
    ),
    [banner.detail, banner.setupCommand, t],
  );
  return (
    <Alert
      variant={BANNER_VARIANT[banner.state]}
      title={titles[banner.state]}
      description={description}
      testID={`knowledge-sidecar-${banner.state}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
