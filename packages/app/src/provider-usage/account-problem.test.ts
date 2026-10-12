import { describe, expect, it } from "vitest";
import { resolveAccountProblem } from "./account-problem";

const SIGNED_OUT = {
  state: "signed_out" as const,
  since: "2026-10-12T18:00:00Z",
  summary: "claude-backup is signed out",
  fixCommand: "CLAUDE_CONFIG_DIR=/home/u/.claude-backup claude auth login",
  canSignIn: true,
};

const WRONG_LOGIN = {
  kind: "wrong-login" as const,
  summary: "claude-backup is signed into someone@example.com, not worker@example.com",
  fixCommand: "claude auth login --email worker@example.com",
};

describe("resolveAccountProblem", () => {
  it("reports a signed-out account with the daemon's sign-in command", () => {
    expect(resolveAccountProblem({ accountAuth: SIGNED_OUT })).toEqual({
      kind: "signed_out",
      summary: "claude-backup is signed out",
      fixCommand: "CLAUDE_CONFIG_DIR=/home/u/.claude-backup claude auth login",
      canSignIn: true,
    });
  });

  it("reports an identity problem, which the app can never sign in for", () => {
    expect(resolveAccountProblem({ accountIdentity: WRONG_LOGIN })).toEqual({
      kind: "identity",
      summary: "claude-backup is signed into someone@example.com, not worker@example.com",
      fixCommand: "claude auth login --email worker@example.com",
      canSignIn: false,
    });
  });

  it("lets a signed-out account win over an identity problem on the same row", () => {
    const problem = resolveAccountProblem({
      accountAuth: SIGNED_OUT,
      accountIdentity: WRONG_LOGIN,
    });
    expect(problem?.kind).toBe("signed_out");
    expect(problem?.summary).toBe("claude-backup is signed out");
  });

  it("reports nothing for a healthy row", () => {
    expect(resolveAccountProblem({})).toBeNull();
  });
});
