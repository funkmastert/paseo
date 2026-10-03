import { describe, expect, it } from "vitest";

import type { AccountPoolProviderEntry } from "../agent/account-pool-providers.js";
import type { ProviderHealth } from "../agent-done-janitor.js";
import {
  buildRemediationPrompt,
  findEscalationAccountBlocker,
  MAX_EVIDENCE_CHARS,
  parseRemediationReport,
} from "./escalation.js";

describe("parseRemediationReport", () => {
  it("reads FIXED and NOT_FIXED from the last non-empty line", () => {
    expect(parseRemediationReport("did things\nREMEDIATION: FIXED — cleared it\n\n")).toEqual({
      outcome: "fixed",
      line: "REMEDIATION: FIXED — cleared it",
    });
    expect(parseRemediationReport("REMEDIATION: NOT_FIXED — needs a person").outcome).toBe(
      "not-fixed",
    );
  });

  it.each([
    ["no text", null],
    ["a report that is not last", "REMEDIATION: FIXED — ok\nthanks!"],
    ["a hyphen for the dash", "REMEDIATION: FIXED - ok"],
    ["an empty reason", "REMEDIATION: FIXED — "],
    ["markdown around it", "**REMEDIATION: FIXED — ok**"],
  ])("counts %s as not fixed", (_label, text) => {
    expect(parseRemediationReport(text).outcome).toBe("not-fixed");
  });
});

describe("buildRemediationPrompt", () => {
  it("cuts evidence past the cap and keeps the report format", () => {
    const prompt = buildRemediationPrompt({
      observation: {
        key: "k",
        kind: "disk-low",
        active: true,
        remedy: "none",
        title: "Disk low",
        summary: "12 GB free.",
        evidence: "x".repeat(MAX_EVIDENCE_CHARS + 50),
      },
      task: "Find what is filling the disk.",
      timeoutMinutes: 45,
      budgetTokens: 2_000_000,
    });
    expect(prompt).toContain("(50 more characters cut)");
    expect(prompt).toContain("- none: no deterministic remedy ran");
    expect(prompt).toContain("never edit ~/.paseo/config.json");
    expect(prompt.trimEnd().endsWith("Any other ending counts as NOT_FIXED.")).toBe(true);
  });
});

describe("findEscalationAccountBlocker", () => {
  const pool: AccountPoolProviderEntry[] = [
    { providerId: "claude", role: "leader", priority: 0, enabled: true },
    { providerId: "claude-personal", role: "worker", priority: 1, enabled: true },
    { providerId: "claude-backup", role: "worker", priority: 2, enabled: false },
  ];
  const health =
    (dead: Set<string>) =>
    async (provider: string): Promise<ProviderHealth> =>
      dead.has(provider) ? { askable: false, reason: `${provider} is capped` } : { askable: true };

  it("is clear while any enabled pooled account is usable", async () => {
    await expect(
      findEscalationAccountBlocker({
        provider: "claude",
        poolEntries: pool,
        getHealth: health(new Set(["claude"])),
      }),
    ).resolves.toBeNull();
  });

  it("blocks when every enabled pooled account is dead", async () => {
    await expect(
      findEscalationAccountBlocker({
        provider: "claude",
        poolEntries: pool,
        getHealth: health(new Set(["claude", "claude-personal"])),
      }),
    ).resolves.toBe("no usable account: claude is capped; claude-personal is capped");
  });

  it("checks only the provider itself outside the pool", async () => {
    await expect(
      findEscalationAccountBlocker({
        provider: "codex",
        poolEntries: pool,
        getHealth: health(new Set(["codex"])),
      }),
    ).resolves.toBe("no usable account: codex is capped");
  });
});
