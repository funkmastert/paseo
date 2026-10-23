import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openExternalUrl } from "@/utils/open-external-url";
import type { Theme } from "@/styles/theme";
import type {
  McpSetupFieldError,
  McpSetupFormInput,
  McpSetupFormModel,
  McpSetupFormState,
} from "./mcp-setup-form-model";
import { getSetupProvider } from "./mcp-setup-providers";
import { useMcpSetupForm, type McpSetupSignInResult } from "./use-mcp-setup-form";

const ThemedCheck = withUnistyles(Check);
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

function fieldErrorKey(error: McpSetupFieldError | null): string | null {
  return error ? `mcpStatus.setup.error.${error}` : null;
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <Text style={styles.stepTitle}>{`${number}. ${title}`}</Text>
      {children}
    </View>
  );
}

interface FormPartProps {
  state: McpSetupFormState;
  model: McpSetupFormModel;
  controlSize: FieldControlSize;
  /** Runs the form's save; the credentials form saves from its body, the token form from its footer. */
  onSubmit: () => void;
}

function LocalTokenFields({ state, model, controlSize }: FormPartProps) {
  const { t } = useTranslation();
  const tokenUrl = state.provider?.localToken?.tokenUrl;
  const providerKey = state.provider?.copyKey ?? "generic";
  const handleGetToken = useCallback(() => {
    if (tokenUrl) void openExternalUrl(tokenUrl);
  }, [tokenUrl]);
  const errorKey = fieldErrorKey(state.tokenError);
  return (
    <>
      <Text style={styles.body}>
        {t("mcpStatus.setup.localToken.intro", { name: state.displayName })}
      </Text>
      {tokenUrl ? (
        <View style={styles.linkBlock}>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ExternalLink}
            onPress={handleGetToken}
            testID="mcp-setup-get-token"
          >
            {t("mcpStatus.setup.localToken.getToken")}
          </Button>
          <Text style={styles.muted}>
            {t(`mcpStatus.setup.providers.${providerKey}.tokenHint`, {
              defaultValue: t("mcpStatus.setup.localToken.tokenHint"),
            })}
          </Text>
        </View>
      ) : null}
      <Field
        label={t("mcpStatus.setup.localToken.tokenLabel")}
        error={errorKey ? t(errorKey) : null}
        testID="mcp-setup-token-field"
      >
        <FormTextInput
          size={controlSize}
          testID="mcp-setup-token-input"
          accessibilityLabel={t("mcpStatus.setup.localToken.tokenLabel")}
          initialValue={state.token}
          onChangeText={model.setToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={state.phase === "editing"}
        />
      </Field>
      <Text style={styles.muted}>{t("mcpStatus.setup.localToken.installNote")}</Text>
    </>
  );
}

interface CreateAppStepProps extends Omit<FormPartProps, "onSubmit"> {
  providerKey: string;
  guided: boolean;
}

/** Step 1: the provider's app-creation link when there is a guide, else where to register. */
function CreateAppStep({ state, model, controlSize, providerKey, guided }: CreateAppStepProps) {
  const { t } = useTranslation();
  const { appUrl } = state;
  const handleCreateApp = useCallback(() => {
    if (appUrl) void openExternalUrl(appUrl);
  }, [appUrl]);
  const redirectErrorKey = fieldErrorKey(state.redirectUrlError);
  if (guided) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          leftIcon={ExternalLink}
          onPress={handleCreateApp}
          disabled={!appUrl}
          testID="mcp-setup-create-app"
        >
          {t(`mcpStatus.setup.providers.${providerKey}.createApp`)}
        </Button>
        <Text style={styles.muted}>
          {t(`mcpStatus.setup.providers.${providerKey}.createAppHint`)}
        </Text>
        <Text style={styles.muted} testID="mcp-setup-admin-note">
          {t("mcpStatus.setup.clientCredentials.adminNote")}
        </Text>
      </>
    );
  }
  if (state.description.status !== "ready") {
    return null;
  }
  return (
    <Field
      label={t("mcpStatus.setup.clientCredentials.redirectLabel")}
      hint={t("mcpStatus.setup.clientCredentials.redirectHint")}
      error={redirectErrorKey ? t(redirectErrorKey) : null}
    >
      <FormTextInput
        size={controlSize}
        testID="mcp-setup-redirect-input"
        accessibilityLabel={t("mcpStatus.setup.clientCredentials.redirectLabel")}
        initialValue={state.redirectUrl}
        onChangeText={model.setRedirectUrl}
        autoCapitalize="none"
        autoCorrect={false}
        editable={state.phase === "editing"}
      />
    </Field>
  );
}

function ClientCredentialsFields({ state, model, controlSize, onSubmit }: FormPartProps) {
  const { t } = useTranslation();
  const providerKey = state.provider?.copyKey ?? "generic";
  const guided = state.provider?.clientCredentials !== undefined;
  const clientIdErrorKey = fieldErrorKey(state.clientIdError);
  const saving = state.phase === "saving";
  const editable = state.phase === "editing";
  const secretKept = state.description.status === "ready" && state.description.clientSecretSet;
  return (
    <>
      <Text style={styles.body}>
        {t(`mcpStatus.setup.providers.${providerKey}.clientCredentialsIntro`, {
          name: state.displayName,
          defaultValue: t("mcpStatus.setup.clientCredentials.intro", { name: state.displayName }),
        })}
      </Text>
      {state.description.status === "failed" ? (
        <Text style={styles.error} testID="mcp-setup-describe-error">
          {t("mcpStatus.setup.describeFailed", { error: state.description.message })}
        </Text>
      ) : null}
      <Step number={1} title={t("mcpStatus.setup.clientCredentials.step1")}>
        <CreateAppStep
          state={state}
          model={model}
          controlSize={controlSize}
          providerKey={providerKey}
          guided={guided}
        />
      </Step>
      <Step number={2} title={t("mcpStatus.setup.clientCredentials.step2")}>
        <Field
          label={t("mcpStatus.setup.clientCredentials.clientIdLabel")}
          error={clientIdErrorKey ? t(clientIdErrorKey) : null}
        >
          <FormTextInput
            size={controlSize}
            testID="mcp-setup-client-id-input"
            accessibilityLabel={t("mcpStatus.setup.clientCredentials.clientIdLabel")}
            initialValue={state.clientId}
            onChangeText={model.setClientId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
          />
        </Field>
        <Field
          label={t("mcpStatus.setup.clientCredentials.clientSecretLabel")}
          hint={secretKept ? t("mcpStatus.setup.clientCredentials.secretKept") : undefined}
        >
          <FormTextInput
            size={controlSize}
            testID="mcp-setup-client-secret-input"
            accessibilityLabel={t("mcpStatus.setup.clientCredentials.clientSecretLabel")}
            initialValue={state.clientSecret}
            onChangeText={model.setClientSecret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
          />
        </Field>
        {guided ? null : (
          <Field label={t("mcpStatus.setup.clientCredentials.scopeLabel")}>
            <FormTextInput
              size={controlSize}
              testID="mcp-setup-scope-input"
              accessibilityLabel={t("mcpStatus.setup.clientCredentials.scopeLabel")}
              initialValue={state.scope}
              onChangeText={model.setScope}
              autoCapitalize="none"
              autoCorrect={false}
              editable={editable}
            />
          </Field>
        )}
        <View style={styles.saveRow}>
          <Button
            variant="outline"
            size="sm"
            onPress={onSubmit}
            disabled={!state.canSubmit}
            loading={saving}
            testID="mcp-setup-save"
          >
            {t("mcpStatus.setup.clientCredentials.save")}
          </Button>
          {state.credentialsSaved ? (
            <View style={styles.savedRow} testID="mcp-setup-credentials-saved">
              <ThemedCheck size={14} uniProps={successColorMapping} />
              <Text style={styles.muted}>{t("mcpStatus.setup.clientCredentials.saved")}</Text>
            </View>
          ) : null}
        </View>
      </Step>
      <Step number={3} title={t("mcpStatus.setup.clientCredentials.step3")}>
        <Text style={styles.muted}>
          {t("mcpStatus.setup.clientCredentials.step3Hint", { name: state.displayName })}
        </Text>
      </Step>
    </>
  );
}

export type McpSetupFormBodyProps = FormPartProps;

/** The form's content, without the sheet around it: what the browser tests mount. */
export const McpSetupFormBody = memo(function McpSetupFormBody(props: McpSetupFormBodyProps) {
  const { state } = props;
  return (
    <View style={styles.stack} testID="mcp-setup-form">
      {state.kind === "local_token" ? (
        <LocalTokenFields {...props} />
      ) : (
        <ClientCredentialsFields {...props} />
      )}
      {state.submitError ? (
        <Text style={styles.error} testID="mcp-setup-submit-error">
          {state.submitError}
        </Text>
      ) : null}
    </View>
  );
});

export interface McpSetupFormFooterProps {
  state: McpSetupFormState;
  onCancel: () => void;
  onSubmit: () => void;
  onSignIn: () => void;
}

export function McpSetupFormFooter({
  state,
  onCancel,
  onSubmit,
  onSignIn,
}: McpSetupFormFooterProps) {
  const { t } = useTranslation();
  const isToken = state.kind === "local_token";
  const saving = state.phase === "saving";
  return (
    <View style={styles.footer}>
      <Button
        style={styles.footerButton}
        variant="secondary"
        onPress={onCancel}
        disabled={saving}
        testID="mcp-setup-cancel"
      >
        {t("common.actions.cancel")}
      </Button>
      {isToken ? (
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={onSubmit}
          disabled={!state.canSubmit}
          loading={saving}
          testID="mcp-setup-footer-save"
        >
          {t("mcpStatus.setup.localToken.save")}
        </Button>
      ) : (
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={onSignIn}
          disabled={!state.canSignIn}
          loading={state.phase === "signingIn"}
          testID="mcp-setup-sign-in"
        >
          {t("mcpStatus.authAction")}
        </Button>
      )}
    </View>
  );
}

interface McpSetupSheetOpenProps {
  serverId: string;
  target: McpSetupFormInput;
  onClose: () => void;
  onDone: () => void;
  onSignIn: (name: string) => Promise<McpSetupSignInResult>;
}

function McpSetupSheetOpen({
  serverId,
  target,
  onClose,
  onDone,
  onSignIn,
}: McpSetupSheetOpenProps) {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { model, state, submit, signIn } = useMcpSetupForm({
    serverId,
    serverName: target.serverName,
    kind: target.kind,
    onDone,
    onSignIn,
  });
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("mcpStatus.setup.title", {
        name: getSetupProvider(target.serverName)?.displayName ?? target.serverName,
      }),
    }),
    [target.serverName, t],
  );
  const footer = useMemo(
    () => (
      <McpSetupFormFooter state={state} onCancel={onClose} onSubmit={submit} onSignIn={signIn} />
    ),
    [onClose, signIn, state, submit],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="mcp-setup-sheet"
    >
      <McpSetupFormBody state={state} model={model} controlSize={controlSize} onSubmit={submit} />
    </AdaptiveModalSheet>
  );
}

export interface McpSetupSheetProps {
  serverId: string | null;
  /** The server and form a row's setup action opened; null while the sheet is closed. */
  target: McpSetupFormInput | null;
  /** The person dismissed the sheet; nothing about the server changed. */
  onClose: () => void;
  /** The form finished its job (token connected, or the sign-in began). */
  onDone: () => void;
  onSignIn: (name: string) => Promise<McpSetupSignInResult>;
}

/**
 * The setup sheet for a row's `setup` action. Mounts a fresh form per open, keyed by the server,
 * and renders nothing while closed (docs/forms.md, lifecycle rule 1).
 */
export function McpSetupSheet({ serverId, target, onClose, onDone, onSignIn }: McpSetupSheetProps) {
  if (!serverId || !target) {
    return null;
  }
  return (
    <McpSetupSheetOpen
      key={`${serverId}:${target.serverName}`}
      serverId={serverId}
      target={target}
      onClose={onClose}
      onDone={onDone}
      onSignIn={onSignIn}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[4],
  },
  step: {
    gap: theme.spacing[2],
  },
  stepTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  body: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  muted: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  linkBlock: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[300],
  },
  saveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
