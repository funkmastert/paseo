import { describe, expect, test } from "vitest";
import {
  AccountClaudeSignInRequestSchema,
  AccountClaudeSignInResponseSchema,
  ProviderUsageSchema,
} from "./messages.js";

describe("ProviderUsageSchema accountAuth", () => {
  const baseRow = {
    providerId: "claude-personal",
    displayName: "Claude",
    status: "unavailable" as const,
    planLabel: null,
    windows: [],
  };

  test("an old-shaped row with no accountAuth still parses", () => {
    const parsed = ProviderUsageSchema.parse(baseRow);
    expect(parsed.accountAuth).toBeUndefined();
  });

  test("a healthy row omits accountAuth", () => {
    const parsed = ProviderUsageSchema.parse({ ...baseRow, status: "available" as const });
    expect(parsed.accountAuth).toBeUndefined();
  });

  test("a signed-out row carries accountAuth", () => {
    const parsed = ProviderUsageSchema.parse({
      ...baseRow,
      accountAuth: {
        state: "signed_out",
        since: "2026-10-12T18:00:00.000Z",
        summary: "Not logged in",
        fixCommand: "CLAUDE_CONFIG_DIR=/x claude /login",
        canSignIn: true,
      },
    });
    expect(parsed.accountAuth).toEqual({
      state: "signed_out",
      since: "2026-10-12T18:00:00.000Z",
      summary: "Not logged in",
      fixCommand: "CLAUDE_CONFIG_DIR=/x claude /login",
      canSignIn: true,
    });
  });
});

describe("account.claude.sign_in RPC schemas", () => {
  test("round-trips a request", () => {
    const parsed = AccountClaudeSignInRequestSchema.parse({
      type: "account.claude.sign_in.request",
      providerId: "claude-personal",
      requestId: "req_1",
    });
    expect(parsed.providerId).toBe("claude-personal");
  });

  test.each(["started", "already_running", "failed"] as const)(
    "accepts a %s response outcome",
    (outcome) => {
      const parsed = AccountClaudeSignInResponseSchema.parse({
        type: "account.claude.sign_in.response",
        payload: {
          providerId: "claude-personal",
          outcome,
          error: outcome === "failed" ? "no claude binary resolved" : null,
          requestId: "req_1",
        },
      });
      expect(parsed.payload.outcome).toBe(outcome);
    },
  );
});
