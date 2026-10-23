import type {
  McpGatewaySetupKind,
  McpGatewaySetupLocalTokenRequest,
  McpGatewaySetupSaveClientRequest,
} from "@getpaseo/protocol/messages";
import { getSetupProvider, type McpSetupProvider } from "./mcp-setup-providers";

/**
 * The model behind the MCP setup forms (docs/forms.md): plain TypeScript, no React. The sheet
 * constructs one per open, renders its state and dispatches intent. Two kinds, one mechanism:
 * `local_token` asks for the token a local server runs with, `client_credentials` collects a
 * hand-made OAuth app's id and secret.
 */
export type McpSetupKind = McpGatewaySetupKind;

/** Which rule a field broke. The sheet owns the wording. */
export type McpSetupFieldError = "required" | "whitespace" | "invalidUrl";

/** What the daemon said about the server, as far as the form needs it. */
export interface McpSetupDescribed {
  redirectUrl: string;
  clientIdSet: boolean;
  /** The client ID already stored, which the form prefills; empty when none is. */
  clientId: string;
  /** The scope already stored, which the form prefills; empty when none is. */
  scope: string;
  clientSecretSet: boolean;
  tokenSet: boolean;
}

export type McpSetupDescription =
  | { status: "idle" }
  | { status: "loading" }
  | ({ status: "ready" } & McpSetupDescribed)
  | { status: "failed"; message: string };

export interface McpSetupFormState {
  kind: McpSetupKind;
  serverName: string;
  /** What the form's sentences call the server. */
  displayName: string;
  provider: McpSetupProvider | undefined;
  token: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUrl: string;
  description: McpSetupDescription;
  /** The daemon holds credentials for this server that match what the fields say. */
  credentialsSaved: boolean;
  phase: "editing" | "saving" | "signingIn";
  submitError: string | null;
  /** Field errors stay quiet until a first submit attempt. */
  showErrors: boolean;
  tokenError: McpSetupFieldError | null;
  clientIdError: McpSetupFieldError | null;
  redirectUrlError: McpSetupFieldError | null;
  /** The provider's app-creation link, once the redirect URL it embeds is known. */
  appUrl: string | null;
  /** The primary action can run: save the token, or save the credentials. */
  canSubmit: boolean;
  canSignIn: boolean;
}

export interface McpSetupFormInput {
  kind: McpSetupKind;
  serverName: string;
}

type SetupRequestBody<Request> = Omit<Request, "type" | "requestId">;

/** What `save_client` sends. A blank secret is left out, which keeps the one already stored. */
export type SaveClientRequest = SetupRequestBody<McpGatewaySetupSaveClientRequest>;

export type LocalTokenRequest = SetupRequestBody<McpGatewaySetupLocalTokenRequest>;

export interface McpSetupFormModel {
  getState(): McpSetupFormState;
  subscribe(listener: () => void): () => void;
  setToken(value: string): void;
  setClientId(value: string): void;
  setClientSecret(value: string): void;
  setScope(value: string): void;
  setRedirectUrl(value: string): void;
  beginDescribe(): void;
  applyDescription(described: McpSetupDescribed): void;
  describeFailed(message: string): void;
  /** Marks errors visible and answers whether the form is valid. */
  attemptSubmit(): boolean;
  beginSaving(): void;
  saveSucceeded(): void;
  saveFailed(message: string): void;
  /** Starts a sign-in; false when one (or a save) is already running or none is available. */
  beginSignIn(): boolean;
  /** The sign-in began, so the browser has the person now. */
  signInStarted(): void;
  signInFailed(message: string): void;
  /** The request `local_token` sends, or null while the token is invalid. */
  localTokenRequest(): LocalTokenRequest | null;
  /** The request `save_client` sends, or null while the form is invalid. */
  saveClientRequest(): SaveClientRequest | null;
  close(): void;
}

function validateToken(token: string): McpSetupFieldError | null {
  const trimmed = token.trim();
  if (!trimmed) return "required";
  return /\s/.test(trimmed) ? "whitespace" : null;
}

function validateRequired(value: string): McpSetupFieldError | null {
  return value.trim() ? null : "required";
}

/** Optional: empty is fine, anything else must be a full http(s) URL. */
function validateRedirectUrl(value: string): McpSetupFieldError | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:" ? null : "invalidUrl";
  } catch {
    return "invalidUrl";
  }
}

function derive(
  base: Omit<
    McpSetupFormState,
    "tokenError" | "clientIdError" | "redirectUrlError" | "appUrl" | "canSubmit" | "canSignIn"
  >,
): McpSetupFormState {
  const tokenError = validateToken(base.token);
  const clientIdError = validateRequired(base.clientId);
  const redirectUrlError = validateRedirectUrl(base.redirectUrl);
  const isToken = base.kind === "local_token";
  const redirect = base.redirectUrl.trim();
  const buildAppUrl = base.provider?.clientCredentials?.buildAppUrl;
  const appUrl = buildAppUrl && redirect && !redirectUrlError ? buildAppUrl(redirect) : null;
  const idle = base.phase === "editing";
  const canSubmit = isToken
    ? idle && tokenError === null
    : idle &&
      base.description.status === "ready" &&
      clientIdError === null &&
      redirectUrlError === null;
  return {
    ...base,
    tokenError: base.showErrors ? tokenError : null,
    clientIdError: base.showErrors ? clientIdError : null,
    redirectUrlError: base.showErrors || base.redirectUrl ? redirectUrlError : null,
    appUrl,
    canSubmit,
    canSignIn: !isToken && idle && base.credentialsSaved,
  };
}

/**
 * Constructs a fresh form. Never reused across opens: a long-lived instance shared between two
 * servers is how one form's secret ends up in the other's field.
 */
export function openMcpSetupForm(input: McpSetupFormInput): McpSetupFormModel {
  const provider = getSetupProvider(input.serverName);
  const listeners = new Set<() => void>();
  let closed = false;
  let raw: Omit<
    McpSetupFormState,
    "tokenError" | "clientIdError" | "redirectUrlError" | "appUrl" | "canSubmit" | "canSignIn"
  > = {
    kind: input.kind,
    serverName: input.serverName,
    displayName: provider?.displayName ?? input.serverName,
    provider,
    token: "",
    clientId: "",
    clientSecret: "",
    scope: provider?.clientCredentials?.scope ?? "",
    redirectUrl: "",
    description: input.kind === "client_credentials" ? { status: "loading" } : { status: "idle" },
    credentialsSaved: false,
    phase: "editing",
    submitError: null,
    showErrors: false,
  };
  let state = derive(raw);

  function publish(patch: Partial<typeof raw>): void {
    if (closed) return;
    raw = { ...raw, ...patch };
    state = derive(raw);
    for (const listener of listeners) listener();
  }

  /** Editing a credential field means what the daemon holds no longer matches the fields. */
  function editClient(patch: Partial<typeof raw>): void {
    publish({ ...patch, credentialsSaved: false, submitError: null });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setToken: (token) => publish({ token, submitError: null }),
    setClientId: (clientId) => editClient({ clientId }),
    setClientSecret: (clientSecret) => editClient({ clientSecret }),
    setScope: (scope) => editClient({ scope }),
    setRedirectUrl: (redirectUrl) => editClient({ redirectUrl }),
    beginDescribe: () => publish({ description: { status: "loading" } }),
    applyDescription(described) {
      publish({
        description: { status: "ready", ...described },
        // What the person already typed wins over what the daemon holds.
        redirectUrl: raw.redirectUrl || described.redirectUrl,
        clientId: raw.clientId || described.clientId,
        // A stored scope is the one in force, so it replaces the provider's default.
        scope: described.scope || raw.scope,
        // Credentials already on the host mean Sign in is available straight away.
        credentialsSaved: raw.credentialsSaved || described.clientIdSet,
      });
    },
    describeFailed: (message) => publish({ description: { status: "failed", message } }),
    attemptSubmit() {
      publish({ showErrors: true });
      return state.canSubmit;
    },
    beginSaving: () => publish({ phase: "saving", submitError: null }),
    saveSucceeded: () =>
      publish({ phase: "editing", credentialsSaved: raw.kind === "client_credentials" }),
    saveFailed: (message) => publish({ phase: "editing", submitError: message }),
    beginSignIn() {
      if (!state.canSignIn) return false;
      publish({ phase: "signingIn", submitError: null });
      return true;
    },
    signInStarted: () => publish({ phase: "editing" }),
    signInFailed: (message) => publish({ phase: "editing", submitError: message }),
    localTokenRequest() {
      const preset = provider?.localToken?.preset;
      if (raw.kind !== "local_token" || !preset || validateToken(raw.token)) return null;
      return { name: raw.serverName, preset, token: raw.token.trim() };
    },
    saveClientRequest() {
      if (raw.kind !== "client_credentials" || validateRequired(raw.clientId)) return null;
      if (validateRedirectUrl(raw.redirectUrl)) return null;
      const clientSecret = raw.clientSecret.trim();
      const redirectUrl = raw.redirectUrl.trim();
      const scope = raw.scope.trim();
      return {
        name: raw.serverName,
        clientId: raw.clientId.trim(),
        ...(clientSecret ? { clientSecret } : {}),
        ...(redirectUrl ? { redirectUrl } : {}),
        ...(scope ? { scope } : {}),
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
