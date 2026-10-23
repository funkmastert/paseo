import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { setupFailureText } from "./mcp-status-copy";
import {
  openMcpSetupForm,
  type McpSetupFormModel,
  type McpSetupFormState,
  type McpSetupKind,
} from "./mcp-setup-form-model";

export interface UseMcpSetupFormInput {
  serverId: string;
  serverName: string;
  kind: McpSetupKind;
  /** The token is saved and the server switched: nothing left for the sheet to do. */
  onDone: () => void;
  /** Starts the sign-in flow the credentials form ends in (the strip's own `startAuth`). */
  onSignIn: (name: string) => Promise<unknown>;
}

export interface UseMcpSetupFormResult {
  model: McpSetupFormModel;
  state: McpSetupFormState;
  /** Saves the token (local server) or the credentials (OAuth app), per the form's kind. */
  submit: () => void;
  signIn: () => void;
}

/**
 * The model's lifetime and its plumbing to the daemon (docs/forms.md): constructed once per
 * mount, closed on unmount, with the one read the credentials form needs piped in as an
 * explicit input rather than reconstructing anything when it lands. The sheet renders state and
 * dispatches intent; every request to the daemon is made here.
 */
export function useMcpSetupForm(input: UseMcpSetupFormInput): UseMcpSetupFormResult {
  const { serverId, serverName, kind, onDone, onSignIn } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [model] = useState(() => openMcpSetupForm({ kind, serverName }));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  useEffect(() => {
    return () => model.close();
  }, [model]);

  useEffect(() => {
    if (kind !== "client_credentials" || !client) return;
    let current = true;
    model.beginDescribe();
    const describe = async (): Promise<void> => {
      try {
        const payload = await client.describeMcpGatewaySetup(serverName);
        if (!current) return;
        if (payload.error || !payload.redirectUrl) {
          model.describeFailed(
            setupFailureText(t, {
              reason: payload.reason ?? null,
              error: payload.error ?? "",
              name: serverName,
            }),
          );
          return;
        }
        model.applyDescription({
          redirectUrl: payload.redirectUrl,
          clientIdSet: payload.clientIdSet === true,
          clientSecretSet: payload.clientSecretSet === true,
          tokenSet: payload.tokenSet === true,
        });
      } catch (error) {
        if (current) model.describeFailed(error instanceof Error ? error.message : String(error));
      }
    };
    void describe();
    return () => {
      current = false;
    };
  }, [client, kind, model, serverName, t]);

  const submit = useCallback(() => {
    if (!client || !model.attemptSubmit()) return;
    const fail = (reason: string | null | undefined, error: string | null | undefined) =>
      model.saveFailed(
        setupFailureText(t, { reason: reason ?? null, error: error ?? "", name: serverName }),
      );
    const run = async (): Promise<void> => {
      try {
        if (kind === "local_token") {
          const request = model.localTokenRequest();
          if (!request) return;
          model.beginSaving();
          const payload = await client.setMcpGatewayLocalToken(request);
          if (payload.error) return fail(payload.reason, payload.error);
          model.saveSucceeded();
          onDone();
          return;
        }
        const request = model.saveClientRequest();
        if (!request) return;
        model.beginSaving();
        const payload = await client.saveMcpGatewayClient(request);
        if (payload.error) return fail(payload.reason, payload.error);
        model.saveSucceeded();
      } catch (error) {
        fail(null, error instanceof Error ? error.message : String(error));
      }
    };
    void run();
  }, [client, kind, model, onDone, serverName, t]);

  const signIn = useCallback(() => {
    void onSignIn(serverName).then(onDone, onDone);
  }, [onDone, onSignIn, serverName]);

  return { model, state, submit, signIn };
}
