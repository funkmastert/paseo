import { describe, expect, it } from "vitest";
import {
  checkAgentProviderMove,
  resolveProviderSessionFamily,
  type AgentProviderMoveCheckInput,
} from "./provider-move.js";

const DERIVED_FROM: Record<string, string | null> = {
  claude: null,
  "claude-personal": "claude",
  "claude-backup": "claude",
  "zai-profile": "claude-personal",
  codex: null,
  "acp-kimi": null,
};

function familyOf(providerId: string): string {
  return resolveProviderSessionFamily(providerId, (id) => DERIVED_FROM[id]);
}

function check(overrides: Partial<AgentProviderMoveCheckInput> = {}) {
  const input: AgentProviderMoveCheckInput = {
    agentId: "agent-1",
    sourceProviderId: "claude-personal",
    targetProviderId: "claude-backup",
    registeredProviderIds: ["claude", "claude-personal", "claude-backup", "codex"],
    targetEnabled: true,
    sourceFamily: familyOf(overrides.sourceProviderId ?? "claude-personal"),
    targetFamily: familyOf(overrides.targetProviderId ?? "claude-backup"),
    sessionId: "11111111-2222-3333-4444-555555555555",
    lifecycle: "idle",
    hasInFlightRun: false,
    ...overrides,
  };
  return checkAgentProviderMove(input);
}

describe("resolveProviderSessionFamily", () => {
  it("resolves a derived account to the built-in provider that owns the transcript", () => {
    expect(familyOf("claude-backup")).toBe("claude");
    expect(familyOf("zai-profile")).toBe("claude");
    expect(familyOf("claude")).toBe("claude");
  });

  it("treats a provider with no base as its own family", () => {
    expect(familyOf("acp-kimi")).toBe("acp-kimi");
  });

  it("stops on a cycle instead of spinning", () => {
    const cyclic: Record<string, string> = { a: "b", b: "a" };
    expect(resolveProviderSessionFamily("a", (id) => cyclic[id])).toBe("a");
  });
});

describe("checkAgentProviderMove", () => {
  it("allows a move between two accounts of the same family", () => {
    expect(check()).toBeNull();
  });

  it("refuses a move across session families and names both", () => {
    const refusal = check({ targetProviderId: "codex" });
    expect(refusal?.code).toBe("incompatible_provider");
    expect(refusal?.message).toContain("'claude' session");
    expect(refusal?.message).toContain("runs 'codex' sessions");
  });

  it("refuses a provider that is not registered and lists the ones that are", () => {
    const refusal = check({ targetProviderId: "claude-ghost" });
    expect(refusal?.code).toBe("unknown_provider");
    expect(refusal?.message).toContain("claude, claude-backup, claude-personal, codex");
  });

  it("refuses a disabled provider", () => {
    expect(check({ targetEnabled: false })?.code).toBe("provider_disabled");
  });

  it("refuses moving an agent onto the provider it is already on", () => {
    expect(check({ targetProviderId: "claude-personal" })?.code).toBe("same_provider");
  });

  it("refuses an agent with no provider session to re-open", () => {
    expect(check({ sessionId: null })?.code).toBe("no_session");
  });

  it("refuses an agent with a turn in flight and says why the turn matters", () => {
    const refusal = check({ hasInFlightRun: true });
    expect(refusal?.code).toBe("agent_busy");
    expect(refusal?.message).toContain("Cancel the turn");
  });

  it.each(["running", "initializing", "closed"] as const)(
    "refuses an agent that is %s",
    (lifecycle) => {
      expect(check({ lifecycle })?.code).toBe("agent_busy");
    },
  );

  it("allows a move for an agent parked in error, which is what a capped account leaves", () => {
    expect(check({ lifecycle: "error" })).toBeNull();
  });

  it("reports the family refusal before the busy one so the caller fixes the real problem", () => {
    expect(check({ targetProviderId: "codex", hasInFlightRun: true })?.code).toBe(
      "incompatible_provider",
    );
  });
});
