// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { mcpStatusQueryKey, useMcpStatus, type McpStatusPayload } from "./use-mcp-status";
import { useMcpHiddenServersStore } from "./mcp-hidden-servers-store";
import { useMcpSetupForm, type UseMcpSetupFormInput } from "./use-mcp-setup-form";
import type { McpStatusServerEntry } from "./mcp-status-strip-model";

const HOST: { serverId: string; label: string } = { serverId: "server-1", label: "Local" };

const sessionState = vi.hoisted(() => ({
  current: {
    sessions: {
      "server-1": {
        serverInfo: { features: { mcpStatus: true, mcpGatewaySetup: true } },
        agents: new Map(),
      },
    },
  },
}));

const i18nState = vi.hoisted(() => ({ t: ((key: string) => key) as unknown }));

const client = vi.hoisted(() => ({
  describeMcpGatewaySetup: vi.fn(),
  saveMcpGatewayClient: vi.fn(),
  setMcpGatewayLocalToken: vi.fn(),
  startMcpGatewayAuth: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: i18nState.t }) }));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [HOST],
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => HOST.serverId,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(sessionState.current),
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

beforeAll(async () => {
  const instance = createInstance();
  await instance.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  i18nState.t = instance.t.bind(instance) as TFunction;
});

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  useMcpHiddenServersStore.setState({ hiddenByServerId: {} });
});

const TOKEN = "figd_fake-token-do-not-use";

function formInput(overrides: Partial<UseMcpSetupFormInput> = {}): UseMcpSetupFormInput {
  return {
    serverId: HOST.serverId,
    serverName: "figma",
    kind: "local_token",
    onDone: vi.fn(),
    onSignIn: vi.fn(async () => ({
      authorizationUrl: "https://example.test/authorize",
      error: null,
    })),
    ...overrides,
  };
}

function typeToken(result: { current: ReturnType<typeof useMcpSetupForm> }, token = TOKEN): void {
  act(() => result.current.model.setToken(token));
}

describe("useMcpSetupForm: describing the credentials form", () => {
  const input = () => formInput({ serverName: "slack", kind: "client_credentials" });

  it("reads what the daemon holds and prefills the stored client ID", async () => {
    client.describeMcpGatewaySetup.mockResolvedValue({
      requestId: "r1",
      error: null,
      redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
      clientIdSet: true,
      clientId: "123.456",
      clientSecretSet: true,
      tokenSet: false,
    });

    const { result } = renderHook(() => useMcpSetupForm(input()));

    await waitFor(() => expect(result.current.state.description.status).toBe("ready"));
    expect(client.describeMcpGatewaySetup).toHaveBeenCalledWith("slack");
    expect(result.current.state.clientId).toBe("123.456");
    expect(result.current.state.credentialsSaved).toBe(true);
    expect(result.current.state.canSignIn).toBe(true);
  });

  it("shows the daemon's reason when it cannot describe the server", async () => {
    client.describeMcpGatewaySetup.mockResolvedValue({
      requestId: "r1",
      error: "The daemon has no reachable address for slack to send you back to",
      reason: "no_redirect_url",
    });

    const { result } = renderHook(() => useMcpSetupForm(input()));

    await waitFor(() => expect(result.current.state.description.status).toBe("failed"));
    expect(result.current.state.description).toEqual({
      status: "failed",
      message: "The daemon has no reachable address for slack to send you back to",
    });
  });

  it("shows a transport failure's message", async () => {
    client.describeMcpGatewaySetup.mockRejectedValue(new Error("Timed out waiting for the daemon"));

    const { result } = renderHook(() => useMcpSetupForm(input()));

    await waitFor(() => expect(result.current.state.description.status).toBe("failed"));
    expect(result.current.state.description).toEqual({
      status: "failed",
      message: "Timed out waiting for the daemon",
    });
  });
});

describe("useMcpSetupForm: saving a token", () => {
  it("sends the trimmed token for the preset and calls onDone once when the server connects", async () => {
    client.setMcpGatewayLocalToken.mockResolvedValue({
      requestId: "r1",
      error: null,
      reason: null,
      status: "connected",
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useMcpSetupForm(formInput({ onDone })));
    typeToken(result, `  ${TOKEN}\n`);

    act(() => result.current.submit());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(client.setMcpGatewayLocalToken).toHaveBeenCalledWith({
      name: "figma",
      preset: "figma",
      token: TOKEN,
    });
    expect(result.current.state.submitError).toBeNull();
  });

  it("keeps the sheet open and says what failed when the daemon refuses", async () => {
    client.setMcpGatewayLocalToken.mockResolvedValue({
      requestId: "r1",
      error: "Installing figma-developer-mcp@0.13.2 failed: npm ERR! 404",
      reason: "install_failed",
      status: null,
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useMcpSetupForm(formInput({ onDone })));
    typeToken(result);

    act(() => result.current.submit());

    await waitFor(() => expect(result.current.state.submitError).not.toBeNull());
    expect(result.current.state.submitError).toBe(
      "Couldn't install the local server: Installing figma-developer-mcp@0.13.2 failed: npm ERR! 404",
    );
    expect(onDone).not.toHaveBeenCalled();
    // The token stays, so a retry needs no retyping.
    expect(result.current.state.token).toBe(TOKEN);
    expect(result.current.state.phase).toBe("editing");
  });

  it.each(["error", "needs-auth", "connecting"])(
    "treats a swapped server that reports %s as a failure: the sheet stays open and the message names the status",
    async (status) => {
      client.setMcpGatewayLocalToken.mockResolvedValue({
        requestId: "r1",
        error: null,
        reason: null,
        status,
      });
      const onDone = vi.fn();
      const { result } = renderHook(() => useMcpSetupForm(formInput({ onDone })));
      typeToken(result);

      act(() => result.current.submit());

      await waitFor(() => expect(result.current.state.submitError).not.toBeNull());
      expect(result.current.state.submitError).toBe(
        `The token is saved, but figma didn't connect (status: ${status}). Check the token, then save again.`,
      );
      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.state.token).toBe(TOKEN);
      expect(result.current.state.phase).toBe("editing");
    },
  );

  it("shows a transport failure's message and keeps the sheet open", async () => {
    client.setMcpGatewayLocalToken.mockRejectedValue(new Error("Connection lost"));
    const onDone = vi.fn();
    const { result } = renderHook(() => useMcpSetupForm(formInput({ onDone })));
    typeToken(result);

    act(() => result.current.submit());

    await waitFor(() => expect(result.current.state.submitError).toBe("Connection lost"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not call the daemon while the token is invalid", () => {
    const { result } = renderHook(() => useMcpSetupForm(formInput()));

    act(() => result.current.submit());

    expect(client.setMcpGatewayLocalToken).not.toHaveBeenCalled();
    expect(result.current.state.tokenError).toBe("required");
  });
});

describe("useMcpSetupForm: saving credentials and signing in", () => {
  async function readyCredentialsForm(onSignIn: UseMcpSetupFormInput["onSignIn"]) {
    client.describeMcpGatewaySetup.mockResolvedValue({
      requestId: "r1",
      error: null,
      redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
      clientIdSet: true,
      clientId: "123.456",
      clientSecretSet: true,
      tokenSet: false,
    });
    const onDone = vi.fn();
    const rendered = renderHook(() =>
      useMcpSetupForm(
        formInput({ serverName: "slack", kind: "client_credentials", onDone, onSignIn }),
      ),
    );
    await waitFor(() => expect(rendered.result.current.state.description.status).toBe("ready"));
    return { ...rendered, onDone };
  }

  it("a blank secret is left out of the request, which keeps the stored one", async () => {
    client.saveMcpGatewayClient.mockResolvedValue({ requestId: "r1", error: null, reason: null });
    const { result, onDone } = await readyCredentialsForm(vi.fn());

    act(() => result.current.submit());

    await waitFor(() => expect(client.saveMcpGatewayClient).toHaveBeenCalledTimes(1));
    const [request] = client.saveMcpGatewayClient.mock.calls[0] ?? [];
    expect(request).toMatchObject({ name: "slack", clientId: "123.456" });
    expect(request).not.toHaveProperty("clientSecret");
    // Saving credentials is not the end: the sheet waits for the sign-in.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("calls onDone once, and only when the sign-in began", async () => {
    const onSignIn = vi.fn(async () => ({
      authorizationUrl: "https://slack.example/authorize",
      error: null,
    }));
    const { result, onDone } = await readyCredentialsForm(onSignIn);

    act(() => result.current.signIn());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onSignIn).toHaveBeenCalledWith("slack");
  });

  it("keeps the sheet open and shows the daemon's sentence when the sign-in fails", async () => {
    const onSignIn = vi.fn(async () => ({
      authorizationUrl: null,
      error: "slack rejected the client secret (invalid_client)",
      reason: "server_rejected",
    }));
    const { result, onDone } = await readyCredentialsForm(onSignIn);

    act(() => result.current.signIn());

    await waitFor(() => expect(result.current.state.submitError).not.toBeNull());
    expect(result.current.state.submitError).toBe(
      "slack rejected the client secret (invalid_client)",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("editing");
  });

  it("keeps the sheet open when the sign-in request itself rejects", async () => {
    const onSignIn = vi.fn(async () => {
      throw new Error("Host disconnected");
    });
    const { result, onDone } = await readyCredentialsForm(onSignIn);

    act(() => result.current.signIn());

    await waitFor(() => expect(result.current.state.submitError).toBe("Host disconnected"));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("ignores a second tap while a sign-in is running", async () => {
    type SignInAnswer = { authorizationUrl: string; error: null };
    let finish: (value: SignInAnswer) => void = () => undefined;
    const onSignIn = vi.fn(
      () =>
        new Promise<SignInAnswer>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, onDone } = await readyCredentialsForm(onSignIn);

    act(() => {
      result.current.signIn();
      result.current.signIn();
    });
    expect(result.current.state.phase).toBe("signingIn");
    expect(result.current.state.canSignIn).toBe(false);
    act(() => result.current.signIn());
    expect(onSignIn).toHaveBeenCalledTimes(1);

    await act(async () =>
      finish({ authorizationUrl: "https://slack.example/authorize", error: null }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe("a failed sign-in from the sheet", () => {
  const slack: McpStatusServerEntry = {
    name: "slack",
    status: "needs-auth",
    critical: false,
    lastChangedAt: 1,
    setup: "client_credentials",
  };

  function Wrapper({ children }: { children: ReactNode }) {
    const [queryClient] = React.useState(() => {
      const queries = new QueryClient();
      const payload: McpStatusPayload = {
        servers: [slack],
        generatedAt: "2026-10-22T00:00:00.000Z",
      };
      queries.setQueryData(mcpStatusQueryKey(HOST.serverId), payload);
      return queries;
    });
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it("leaves the failure the row recorded in place, because nothing closes the sheet", async () => {
    client.describeMcpGatewaySetup.mockResolvedValue({
      requestId: "r1",
      error: null,
      redirectUrl: "http://localhost:6767/mcp/gateway/oauth/callback",
      clientIdSet: true,
      clientId: "123.456",
      clientSecretSet: true,
      tokenSet: false,
    });
    client.startMcpGatewayAuth.mockResolvedValue({
      requestId: "r2",
      authorizationUrl: null,
      error: "slack rejected the client secret (invalid_client)",
      reason: "server_rejected",
    });
    const onDone = vi.fn();
    const { result } = renderHook(
      () => {
        const status = useMcpStatus();
        const form = useMcpSetupForm(
          formInput({
            serverName: "slack",
            kind: "client_credentials",
            onDone,
            onSignIn: status.startAuth,
          }),
        );
        return { status, form };
      },
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.form.state.description.status).toBe("ready"));

    act(() => result.current.form.signIn());

    await waitFor(() => expect(result.current.form.state.submitError).not.toBeNull());
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.status.model.rows[0]?.failure).toMatchObject({
      reason: "server_rejected",
      error: "slack rejected the client secret (invalid_client)",
    });
  });
});
