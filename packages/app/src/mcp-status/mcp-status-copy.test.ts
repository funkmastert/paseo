import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { failureText, reportedByText } from "./mcp-status-copy";
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

function row(lastFailure?: McpStatusActionFailure): McpStatusRow {
  return {
    key: "session:amplitude",
    name: "amplitude",
    tone: "warning",
    statusKey: "sessionReported",
    critical: false,
    annotation: annotation(),
    ...(lastFailure ? { failure: lastFailure } : {}),
    sessionOnly: true,
  };
}

function failure(overrides: Partial<McpStatusActionFailure> = {}): McpStatusActionFailure {
  return { reason: null, remedyCommand: null, error: "boom", ...overrides };
}

describe("reportedByText", () => {
  it("names the account instead of counting the agents stuck behind it", () => {
    expect(t).toBeDefined();
    expect(
      reportedByText(t, annotation({ reporterCount: 15, providerIds: ["claude-personal"] })),
    ).toBe("On claude-personal");
  });

  it("names the agent and its account when only one reported", () => {
    expect(reportedByText(t, annotation())).toBe("Amp analyst on claude-personal");
  });

  it("falls back to a count only when the reporters are genuinely independent", () => {
    expect(
      reportedByText(
        t,
        annotation({ reporterCount: 4, providerIds: ["claude-backup", "claude-personal"] }),
      ),
    ).toBe("Reported by 4 agents");
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
