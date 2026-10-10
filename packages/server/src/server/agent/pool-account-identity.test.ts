import { describe, expect, it } from "vitest";
import type { AgentAccountAuth } from "./agent-sdk-types.js";
import {
  findPoolAccountIdentityProblems,
  PoolAccountIdentityTracker,
  type PoolAccountReading,
} from "./pool-account-identity.js";

function signedIn(email: string, uuid: string | null = null): AgentAccountAuth {
  return { state: "signed-in", accountLabel: email, accountUuid: uuid };
}

function reading(
  providerId: string,
  auth: AgentAccountAuth | null,
  extra: Partial<PoolAccountReading> = {},
): PoolAccountReading {
  return {
    providerId,
    configDir: `/home/u/.${providerId}`,
    expectedEmail: null,
    auth,
    ...extra,
  };
}

describe("findPoolAccountIdentityProblems", () => {
  it("flags the entry that shares a login with the leader, and names the fix", () => {
    const problems = findPoolAccountIdentityProblems([
      reading("claude", signedIn("leader@example.com", "uuid-1"), { role: "leader" }),
      reading("claude-personal", signedIn("leader@example.com", "uuid-1"), {
        expectedEmail: "worker@example.com",
      }),
      reading("claude-backup", signedIn("backup@example.com", "uuid-2")),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      providerId: "claude-personal",
      kind: "shared-login",
      signedInEmail: "leader@example.com",
      expectedEmail: "worker@example.com",
      sharesWith: ["claude"],
    });
    expect(problems[0]?.fixCommand).toBe(
      "CLAUDE_CONFIG_DIR=/home/u/.claude-personal claude auth login --email worker@example.com",
    );
  });

  it("keeps the entry whose declared email matches the shared login", () => {
    const problems = findPoolAccountIdentityProblems([
      reading("claude", signedIn("worker@example.com", "uuid-1"), {
        role: "leader",
        expectedEmail: "leader@example.com",
      }),
      reading("claude-personal", signedIn("worker@example.com", "uuid-1"), {
        expectedEmail: "worker@example.com",
      }),
    ]);

    expect(problems.map((p) => p.providerId)).toEqual(["claude"]);
  });

  it("matches on account id, so two different emails on one id still collapse", () => {
    const problems = findPoolAccountIdentityProblems([
      reading("claude", signedIn("a@example.com", "uuid-1")),
      reading("claude-personal", signedIn("b@example.com", "uuid-1")),
    ]);

    expect(problems.map((p) => p.kind)).toEqual(["shared-login"]);
  });

  it("does not flag a declared email that differs only in case", () => {
    const problems = findPoolAccountIdentityProblems([
      reading("claude-personal", signedIn("Leader@Example.com", "uuid-1"), {
        expectedEmail: "leader@example.com",
      }),
      reading("claude-backup", signedIn("backup@example.com", "uuid-2")),
    ]);

    expect(problems).toEqual([]);
  });

  it("reports a wrong login with the account it is on", () => {
    const problems = findPoolAccountIdentityProblems([
      reading("claude-personal", signedIn("leader@example.com", "uuid-1"), {
        expectedEmail: "worker@example.com",
      }),
    ]);

    expect(problems).toEqual([
      expect.objectContaining({
        providerId: "claude-personal",
        kind: "wrong-login",
        signedInEmail: "leader@example.com",
        sharesWith: [],
        summary: "claude-personal is signed into leader@example.com, not worker@example.com",
      }),
    ]);
  });

  it("says nothing for signed-out, unknown, or unlabelled accounts", () => {
    expect(
      findPoolAccountIdentityProblems([
        reading(
          "a",
          { state: "signed-out", signInCommand: null },
          { expectedEmail: "x@example.com" },
        ),
        reading("b", { state: "unknown" }),
        reading("c", { state: "signed-in", accountLabel: null, accountUuid: null }),
        reading("d", { state: "signed-in", accountLabel: null, accountUuid: null }),
      ]),
    ).toEqual([]);
  });
});

describe("PoolAccountIdentityTracker", () => {
  const problem = findPoolAccountIdentityProblems([
    reading("claude-personal", signedIn("leader@example.com", "uuid-1"), {
      expectedEmail: "worker@example.com",
    }),
  ]);

  it("raises an episode once while it stands, and again after it clears", () => {
    const tracker = new PoolAccountIdentityTracker();
    expect(tracker.observe(problem)).toHaveLength(1);
    expect(tracker.observe(problem)).toEqual([]);
    expect(tracker.problemFor("claude-personal")).not.toBeNull();

    expect(tracker.observe([])).toEqual([]);
    expect(tracker.problemFor("claude-personal")).toBeNull();
    expect(tracker.observe(problem)).toHaveLength(1);
  });
});
