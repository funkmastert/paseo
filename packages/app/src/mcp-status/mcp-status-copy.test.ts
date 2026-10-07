import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import {
  actionLabelText,
  clientCredentialsSnippet,
  compactStatusText,
  failureClipboardText,
  failureText,
  headlineText,
  remedyLines,
  reportedByText,
  secondLineText,
  statusText,
} from "./mcp-status-copy";
import type {
  McpStatusActionFailure,
  McpStatusRow,
  McpStatusRowAnnotation,
} from "./mcp-status-strip-model";

let t: TFunction;

beforeAll(async () => {
  const instance = createInstance();
  await instance.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  t = instance.t.bind(instance) as TFunction;
});

function annotation(overrides: Partial<McpStatusRowAnnotation> = {}): McpStatusRowAnnotation {
  return {
    agentLabel: "Amp analyst",
    agentId: "agent-1",
    agentProvider: "claude-personal",
    reporterCount: 1,
    providerIds: ["claude-personal"],
    ...overrides,
  };
}

function row(
  lastFailure?: McpStatusActionFailure,
  overrides: Partial<McpStatusRow> = {},
): McpStatusRow {
  return {
    key: "session:amplitude",
    name: "amplitude",
    tone: "warning",
    statusKey: "sessionReported",
    critical: false,
    annotation: annotation(),
    ...(lastFailure ? { failure: lastFailure } : {}),
    sessionOnly: true,
    ...overrides,
  };
}

function brokeredRow(overrides: Partial<McpStatusRow> = {}): McpStatusRow {
  return row(undefined, {
    key: "server:github",
    name: "github",
    statusKey: "needsAuth",
    sessionOnly: false,
    ...overrides,
  });
}

function failure(overrides: Partial<McpStatusActionFailure> = {}): McpStatusActionFailure {
  return {
    reason: null,
    remedyCommand: null,
    remedyPath: null,
    remedyRedirectUrl: null,
    error: "boom",
    ...overrides,
  };
}

describe("reportedByText", () => {
  it("names the account instead of counting the agents stuck behind it", () => {
    expect(t).toBeDefined();
    const many = row(undefined, {
      annotation: annotation({ reporterCount: 15, providerIds: ["claude-personal"] }),
    });

    // Lower case: it only ever follows the status, after a separator.
    expect(reportedByText(t, many)).toBe("on claude-personal");
  });

  it("names the agent and its account when only one reported", () => {
    expect(reportedByText(t, row())).toBe("Amp analyst on claude-personal");
  });

  it("falls back to a count only when the reporters are genuinely independent", () => {
    const mixed = row(undefined, {
      annotation: annotation({
        reporterCount: 4,
        providerIds: ["claude-backup", "claude-personal"],
      }),
    });

    expect(reportedByText(t, mixed)).toBe("Reported by 4 agents");
  });

  it("says nothing on a brokered row the gateway already calls unhealthy", () => {
    // "Needs auth · Reported by 8 agents" counts who noticed; the status and its button
    // already say what to do, and the same fix serves all eight.
    expect(
      reportedByText(t, brokeredRow({ annotation: annotation({ reporterCount: 8 }) })),
    ).toBeNull();
    expect(reportedByText(t, brokeredRow({ statusKey: "error" }))).toBeNull();
  });

  it("keeps the reporters on a brokered row the gateway thinks is fine", () => {
    // Then they are the only sign anything is wrong.
    expect(reportedByText(t, brokeredRow({ statusKey: "connected" }))).toBe(
      "Amp analyst on claude-personal",
    );
  });
});

describe("failureText", () => {
  it("says the account is signed out and never claims authentication failed", () => {
    const text = failureText(
      t,
      row(),
      failure({
        reason: "account_signed_out",
        remedyCommand: "CLAUDE_CONFIG_DIR=/home/t/.claude-personal claude /login",
        error: "The account in /home/t/.claude-personal is not signed in",
      }),
    );

    expect(text).toBe("claude-personal isn't signed in. Run this on the host, then try again:");
    expect(text).not.toContain("Authentication failed");
  });

  it("admits it cannot tell where the agent loaded the server from", () => {
    expect(failureText(t, row(), failure({ reason: "server_not_in_config" }))).toBe(
      "amplitude isn't in the MCP config Paseo reads for claude-personal. The agent loads it " +
        "from somewhere else, and Paseo can't tell where.",
    );
  });

  it("explains a local server rather than offering to sign into it", () => {
    expect(failureText(t, row(), failure({ reason: "server_is_local" }))).toBe(
      "amplitude runs as a local command. Only http and sse servers can be brokered.",
    );
  });

  it("names the provider whose config could not be read", () => {
    expect(failureText(t, row(), failure({ reason: "provider_has_no_config" }))).toBe(
      "Paseo can't read claude-personal's MCP config, so it can't broker this.",
    );
  });

  it("calls it authentication only after a definition was adopted", () => {
    expect(
      failureText(t, row(), failure({ reason: "authorization_failed", error: "discovery failed" })),
    ).toBe("Sign-in failed: discovery failed");
    expect(
      failureText(t, row(), failure({ reason: "adopt_failed", error: "gateway refused" })),
    ).toBe("Couldn't broker amplitude: gateway refused");
  });

  it("passes an unrecognised or absent reason's own sentence through unchanged", () => {
    // A newer daemon's cause this build has no copy for, and an older daemon that sends none.
    expect(failureText(t, row(), failure({ reason: "some_future_cause", error: "raw" }))).toBe(
      "raw",
    );
    expect(failureText(t, row(), failure({ error: "raw" }))).toBe("raw");
  });
});

describe("failureText for the errors Tyler was shown", () => {
  it("does not call a missing OAuth client an authentication failure", () => {
    const text = failureText(
      t,
      brokeredRow(),
      failure({
        reason: "client_not_registered",
        remedyRedirectUrl: "https://host.example/mcp/gateway/oauth/callback",
        remedyPath: "/home/t/.paseo/mcp-gateway/tokens.json",
        error: 'MCP server "github" needs an OAuth app you register yourself…',
      }),
    );

    expect(text).not.toContain("Authentication failed");
    // Leads with what to do, not with what the server does not support.
    expect(text.indexOf("Register an OAuth app")).toBe(0);
    expect(text.indexOf("doesn't offer automatic registration")).toBeGreaterThan(0);
  });

  it("shows the daemon's humanised refusal rather than a JSON parse error", () => {
    const text = failureText(
      t,
      row(undefined, { name: "figma" }),
      failure({
        reason: "server_rejected",
        error: "figma refused the sign-in request with HTTP 403 and said: Forbidden.",
      }),
    );

    expect(text).toBe("figma refused the sign-in request with HTTP 403 and said: Forbidden.");
    expect(text).not.toContain("SyntaxError");
  });

  it("tells the reader a refused registration is not theirs to fix", () => {
    // Figma: it advertises dynamic registration and then 403s every caller, because only
    // clients in its own catalog may connect. Offering credentials here would be a false lead —
    // that is the remedy for `client_not_registered`, which this deliberately is not.
    const text = failureText(
      t,
      row(undefined, { name: "figma" }),
      failure({
        reason: "client_registration_refused",
        error: 'MCP server "figma" refused to register Paseo as a client (HTTP 403).',
      }),
    );

    expect(text).toContain("won't register Paseo as a client");
    expect(text).toContain("allowlist");
    expect(text).toContain("local server");
    expect(text).not.toContain("clientCredentials");
    expect(text).not.toContain("SyntaxError");
  });

  it("explains a static-auth server instead of offering to authenticate it", () => {
    expect(failureText(t, brokeredRow(), failure({ reason: "static_auth" }))).toBe(
      "github signs in with a stored header, so there's nothing to authorize.",
    );
  });
});

describe("remedyLines", () => {
  const missingClient = failure({
    reason: "client_not_registered",
    remedyRedirectUrl: "https://host.example/mcp/gateway/oauth/callback",
    remedyPath: "/home/t/.paseo/mcp-gateway/tokens.json",
  });

  it("hands over every host fact needed to register an OAuth app, in working order", () => {
    expect(remedyLines(t, brokeredRow(), missingClient)).toEqual([
      {
        key: "redirectUrl",
        label: "Redirect URI to register",
        value: "https://host.example/mcp/gateway/oauth/callback",
      },
      { key: "path", label: "File on the host", value: "/home/t/.paseo/mcp-gateway/tokens.json" },
      { key: "snippet", label: "Add", value: clientCredentialsSnippet("github") },
    ]);
  });

  it("writes a snippet that is valid JSON naming the server", () => {
    expect(JSON.parse(clientCredentialsSnippet("github"))).toEqual({
      servers: {
        github: { auth: "oauth", clientCredentials: { clientId: "…", clientSecret: "…" } },
      },
    });
  });

  it("offers the sign-in command for a signed-out account and nothing else", () => {
    const signedOut = failure({
      reason: "account_signed_out",
      remedyCommand: "CLAUDE_CONFIG_DIR=/home/t/.claude-personal claude /login",
    });

    expect(remedyLines(t, row(), signedOut)).toEqual([
      {
        key: "command",
        label: "Run on the host",
        value: "CLAUDE_CONFIG_DIR=/home/t/.claude-personal claude /login",
      },
    ]);
  });

  it("offers nothing when the daemon sent nothing to act on", () => {
    expect(remedyLines(t, row(), failure({ reason: "server_rejected" }))).toEqual([]);
  });
});

describe("failureClipboardText", () => {
  it("copies the whole instruction, which is the part nobody retypes by hand", () => {
    const copied = failureClipboardText(
      t,
      brokeredRow(),
      failure({
        reason: "client_not_registered",
        remedyRedirectUrl: "https://host.example/mcp/gateway/oauth/callback",
        remedyPath: "/home/t/.paseo/mcp-gateway/tokens.json",
      }),
    );

    expect(copied).toContain("github: Register an OAuth app for github");
    expect(copied).toContain("https://host.example/mcp/gateway/oauth/callback");
    expect(copied).toContain("/home/t/.paseo/mcp-gateway/tokens.json");
    expect(copied).toContain('"clientCredentials"');
  });
});

describe("headlineText", () => {
  it("names one server by what it needs", () => {
    expect(headlineText(t, { kind: "needsSignIn", name: "linear" })).toBe("linear needs sign-in");
    expect(headlineText(t, { kind: "needsAttention", name: "zeeq" })).toBe("zeeq needs attention");
  });

  it("counts several instead of listing names a sidebar row cannot fit", () => {
    expect(headlineText(t, { kind: "manyNeedAttention", count: 5 })).toBe(
      "5 MCP servers need attention",
    );
  });

  it("counts the connected servers when nothing needs attention", () => {
    expect(headlineText(t, { kind: "connected", count: 9 })).toBe("9 MCP servers connected");
    expect(headlineText(t, { kind: "connected", count: 1 })).toBe("1 MCP server connected");
  });
});

describe("statusText", () => {
  it("says a server needs sign-in, not auth", () => {
    expect(statusText(t, brokeredRow())).toBe("Needs sign-in");
  });

  it("calls a claude.ai connector what it is and names the account after it", () => {
    const connector = row(undefined, {
      key: "session:claude.ai Robinhood",
      name: "claude.ai Robinhood",
      statusKey: "claudeAiConnector",
      annotation: annotation({ reporterCount: 2, providerIds: ["claude-2"] }),
    });

    expect(statusText(t, connector)).toBe("claude.ai connector · on claude-2");
  });
});

describe("secondLineText", () => {
  it("shows the failure in place of the status, never both", () => {
    const failed = brokeredRow({
      failure: failure({ reason: "authorization_failed", error: "Invalid refresh token" }),
    });

    expect(secondLineText(t, failed)).toBe("Sign-in failed: Invalid refresh token");
  });

  it("falls back to the status when nothing has failed yet", () => {
    expect(secondLineText(t, brokeredRow())).toBe("Needs sign-in");
  });
});

describe("actionLabelText", () => {
  it("asks to sign in, or to sign in again after an error", () => {
    expect(actionLabelText(t, brokeredRow({ action: "authenticate" }))).toBe("Sign in");
    expect(actionLabelText(t, brokeredRow({ action: "authenticate", statusKey: "error" }))).toBe(
      "Sign in again",
    );
  });

  it("calls the claude.ai hand-off a sign-in too, and keeps Broker & sign in", () => {
    expect(actionLabelText(t, row(undefined, { action: "openClaudeAi" }))).toBe("Sign in");
    expect(actionLabelText(t, row(undefined, { action: "adopt" }))).toBe("Broker & sign in");
  });
});

describe("compactStatusText", () => {
  function healthyRow(overrides: Partial<McpStatusRow> = {}): McpStatusRow {
    return brokeredRow({
      key: "server:zeeq",
      name: "zeeq",
      tone: "ok",
      statusKey: "connected",
      annotation: undefined,
      ...overrides,
    });
  }

  it("says nothing for a plain connected server, which the green dot already says", () => {
    expect(compactStatusText(t, healthyRow())).toBeNull();
  });

  it("names any state the dot does not", () => {
    expect(compactStatusText(t, healthyRow({ statusKey: "connecting", tone: "default" }))).toBe(
      "Connecting",
    );
    expect(compactStatusText(t, healthyRow({ statusKey: "disabled", tone: "default" }))).toBe(
      "Disabled",
    );
  });

  it("keeps the reporters on a connected server, where they are the only sign of trouble", () => {
    expect(compactStatusText(t, healthyRow({ annotation: annotation() }))).toBe(
      "Connected · Amp analyst on claude-personal",
    );
  });
});
