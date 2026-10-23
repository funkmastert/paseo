import { describe, expect, it, vi } from "vitest";
import { openMcpSetupForm, type McpSetupDescribed } from "./mcp-setup-form-model";
import { slackScopeString } from "./mcp-setup-providers";

const REDIRECT = "http://localhost:6767/mcp/gateway/oauth/callback";
const described = (overrides: Partial<McpSetupDescribed> = {}): McpSetupDescribed => ({
  redirectUrl: REDIRECT,
  clientIdSet: false,
  clientId: "",
  scope: "",
  clientSecretSet: false,
  tokenSet: false,
  ...overrides,
});

describe("local token form", () => {
  it("cannot submit an empty or whitespace-only token", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    expect(form.getState().canSubmit).toBe(false);
    form.setToken("   ");
    expect(form.getState().canSubmit).toBe(false);
    expect(form.localTokenRequest()).toBeNull();
  });

  it("keeps errors quiet until the first attempt, then names the broken rule", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    expect(form.getState().tokenError).toBeNull();
    expect(form.attemptSubmit()).toBe(false);
    expect(form.getState().tokenError).toBe("required");
    form.setToken("figd_one two");
    expect(form.getState().tokenError).toBe("whitespace");
    form.setToken("figd_fake-token-do-not-use");
    expect(form.getState().tokenError).toBeNull();
  });

  it("submits the trimmed token with the provider's preset", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    form.setToken("  figd_fake-token-do-not-use \n");
    expect(form.getState().canSubmit).toBe(true);
    expect(form.localTokenRequest()).toEqual({
      name: "figma",
      preset: "figma",
      token: "figd_fake-token-do-not-use",
    });
  });

  it("has no request for a server that has no local-server preset", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "linear" });
    form.setToken("figd_fake-token-do-not-use");
    expect(form.localTokenRequest()).toBeNull();
  });

  it("cannot be submitted again while saving, and a failure comes back editable with its message", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    form.setToken("figd_fake-token-do-not-use");
    form.beginSaving();
    expect(form.getState()).toMatchObject({ phase: "saving", canSubmit: false });
    form.saveFailed("npm was not found");
    expect(form.getState()).toMatchObject({
      phase: "editing",
      canSubmit: true,
      submitError: "npm was not found",
    });
    form.setToken("figd_other-fake-token");
    expect(form.getState().submitError).toBeNull();
  });
});

describe("client credentials form", () => {
  it("waits for the daemon's description before it can submit", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.setClientId("123.456");
    expect(form.getState().description.status).toBe("loading");
    expect(form.getState().canSubmit).toBe(false);
    form.applyDescription(described());
    expect(form.getState().canSubmit).toBe(true);
  });

  it("prefills the redirect from the daemon and the scope from the provider", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described());
    expect(form.getState().redirectUrl).toBe(REDIRECT);
    expect(form.getState().scope).toBe(slackScopeString());
  });

  it("does not overwrite a redirect the person already typed", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "other" });
    form.setRedirectUrl("http://localhost:7000/mcp/gateway/oauth/callback");
    form.applyDescription(described());
    expect(form.getState().redirectUrl).toBe("http://localhost:7000/mcp/gateway/oauth/callback");
  });

  it("builds Slack's app link from the redirect the daemon gave", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    expect(form.getState().appUrl).toBeNull();
    form.applyDescription(described());
    const url = new URL(form.getState().appUrl ?? "");
    expect(JSON.parse(url.searchParams.get("manifest_json") ?? "null").oauth_config).toMatchObject({
      redirect_urls: [REDIRECT],
    });
  });

  it("a server with no guide gets no app link, just the generic fields", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "other" });
    form.applyDescription(described());
    expect(form.getState().appUrl).toBeNull();
    expect(form.getState().scope).toBe("");
  });

  it("requires a client id, treats the secret as optional, and rejects a redirect that is not a URL", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described());
    expect(form.attemptSubmit()).toBe(false);
    expect(form.getState().clientIdError).toBe("required");
    form.setClientId("123.456");
    expect(form.attemptSubmit()).toBe(true);
    expect(form.saveClientRequest()).toEqual({
      name: "slack",
      clientId: "123.456",
      redirectUrl: REDIRECT,
      scope: slackScopeString(),
    });
    form.setRedirectUrl("localhost:6767/callback");
    expect(form.getState().redirectUrlError).toBe("invalidUrl");
    expect(form.getState().canSubmit).toBe(false);
    expect(form.saveClientRequest()).toBeNull();
  });

  it("sends the secret trimmed when there is one", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described());
    form.setClientId(" 123.456 ");
    form.setClientSecret("  shh-secret-value ");
    expect(form.saveClientRequest()).toMatchObject({
      clientId: "123.456",
      clientSecret: "shh-secret-value",
    });
  });

  it("Sign in is gated on saved credentials, and editing a credential field takes it away again", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described());
    form.setClientId("123.456");
    expect(form.getState().canSignIn).toBe(false);
    form.beginSaving();
    form.saveSucceeded();
    expect(form.getState()).toMatchObject({ credentialsSaved: true, canSignIn: true });
    form.setClientSecret("a-new-secret-value");
    expect(form.getState()).toMatchObject({ credentialsSaved: false, canSignIn: false });
  });

  it("credentials already on the host open with Sign in available", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described({ clientIdSet: true, clientSecretSet: true }));
    expect(form.getState().canSignIn).toBe(true);
  });

  it("prefills the stored client ID, but not over one the person already typed", () => {
    const fresh = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    fresh.applyDescription(described({ clientIdSet: true, clientId: "123.456" }));
    expect(fresh.getState().clientId).toBe("123.456");

    const typed = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    typed.setClientId("789.012");
    typed.applyDescription(described({ clientIdSet: true, clientId: "123.456" }));
    expect(typed.getState().clientId).toBe("789.012");
  });

  it("a stored scope replaces the provider's default, and no stored scope leaves the default", () => {
    const stored = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    stored.applyDescription(
      described({ clientIdSet: true, clientId: "123.456", scope: "users:read" }),
    );
    expect(stored.getState().scope).toBe("users:read");

    const none = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    none.applyDescription(described());
    expect(none.getState().scope).toBe(slackScopeString());
  });

  it("correcting a saved app: the prefilled ID with a blank secret sends no secret, which keeps the stored one", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(
      described({ clientIdSet: true, clientId: "123.456", clientSecretSet: true }),
    );
    form.setScope("users:read");

    const request = form.saveClientRequest();

    expect(request).toEqual({
      name: "slack",
      clientId: "123.456",
      redirectUrl: REDIRECT,
      scope: "users:read",
    });
    expect(request).not.toHaveProperty("clientSecret");
  });

  it("a sign-in locks the form until it answers, and a second one cannot start meanwhile", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described({ clientIdSet: true, clientId: "123.456" }));

    expect(form.beginSignIn()).toBe(true);
    expect(form.getState()).toMatchObject({
      phase: "signingIn",
      canSignIn: false,
      canSubmit: false,
    });
    expect(form.beginSignIn()).toBe(false);

    form.signInFailed("slack rejected the client secret");
    expect(form.getState()).toMatchObject({
      phase: "editing",
      canSignIn: true,
      submitError: "slack rejected the client secret",
    });
    expect(form.beginSignIn()).toBe(true);
    form.signInStarted();
    expect(form.getState().phase).toBe("editing");
  });

  it("cannot sign in before credentials exist", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.applyDescription(described());
    expect(form.beginSignIn()).toBe(false);
    expect(form.getState().phase).toBe("editing");
  });

  it("a failed description leaves the form unable to submit and says why", () => {
    const form = openMcpSetupForm({ kind: "client_credentials", serverName: "slack" });
    form.describeFailed("no reachable address");
    form.setClientId("123.456");
    expect(form.getState().description).toEqual({
      status: "failed",
      message: "no reachable address",
    });
    expect(form.getState().canSubmit).toBe(false);
  });
});

describe("lifecycle", () => {
  it("notifies subscribers on change and stops after close", () => {
    const form = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    const listener = vi.fn();
    const unsubscribe = form.subscribe(listener);
    form.setToken("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    form.setToken("ab");
    expect(listener).toHaveBeenCalledTimes(1);
    form.close();
    form.setToken("abc");
    expect(form.getState().token).toBe("ab");
  });

  it("each open starts clean, whatever the last one held", () => {
    const first = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    first.setToken("figd_fake-token-do-not-use");
    first.close();
    const second = openMcpSetupForm({ kind: "local_token", serverName: "figma" });
    expect(second.getState().token).toBe("");
  });
});
