import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_PROFILE,
  ToolProfileSchema,
  applyToolProfile,
  profileDeniedTools,
  type ToolProfile,
} from "./tool-profiles";

function denied(profile: ToolProfile): string[] {
  return profileDeniedTools(profile).sort();
}

describe("profileDeniedTools", () => {
  it("unrestricted denies nothing (today's behaviour, the default)", () => {
    expect(denied({ kind: "unrestricted" })).toEqual([]);
    expect(DEFAULT_TOOL_PROFILE).toEqual({ kind: "unrestricted" });
  });

  it("orchestrator denies every file and shell tool", () => {
    const tools = denied({ kind: "orchestrator" });
    for (const tool of ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
      expect(tools, `${tool} must be denied`).toContain(tool);
    }
  });

  it("orchestrator denies native subagent launchers, which spend the parent's own budget", () => {
    const tools = denied({ kind: "orchestrator" });
    expect(tools).toContain("Task");
    expect(tools).toContain("Agent");
  });

  it("read-only keeps the read tools and denies every mutation path", () => {
    const tools = denied({ kind: "read-only" });
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Grep");
    expect(tools).not.toContain("Glob");
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
      expect(tools, `${tool} must be denied`).toContain(tool);
    }
  });

  it("read-only denies Bash, because a shell redirect writes files too", () => {
    expect(denied({ kind: "read-only" })).toContain("Bash");
  });

  it("write denies nothing: file and shell tools are the point of the profile", () => {
    expect(denied({ kind: "write" })).toEqual([]);
  });

  it("custom uses the role's own deny list", () => {
    expect(denied({ kind: "custom", deny: ["Bash", "WebFetch"] })).toEqual(["Bash", "WebFetch"]);
  });
});

describe("applyToolProfile", () => {
  it("returns undefined for a profile that restricts nothing, so the request stays byte-identical", () => {
    expect(applyToolProfile(undefined, { kind: "unrestricted" })).toBeUndefined();
    expect(applyToolProfile({ additionalDirectories: ["/tmp"] }, { kind: "write" })).toBeUndefined();
  });

  it("writes both enforcement layers: disallowedTools and settings.permissions.deny", () => {
    const result = applyToolProfile(undefined, { kind: "read-only" });

    expect(result?.disallowedTools).toContain("Write");
    const permissions = (result?.settings as { permissions: { deny: string[] } }).permissions;
    expect(permissions.deny).toContain("Write(*)");
  });

  it("unions with a deny list the caller already set, never dropping it", () => {
    const result = applyToolProfile(
      {
        disallowedTools: ["WebFetch"],
        settings: { permissions: { deny: ["WebFetch(*)"] } },
      },
      { kind: "read-only" },
    );

    expect(result?.disallowedTools).toContain("WebFetch");
    expect(result?.disallowedTools).toContain("Bash");
    const permissions = (result?.settings as { permissions: { deny: string[] } }).permissions;
    expect(permissions.deny).toContain("WebFetch(*)");
    expect(permissions.deny).toContain("Bash(*)");
  });

  it("cannot weaken a caller restriction the profile itself allows", () => {
    // `write` denies nothing, but the caller denied Bash. Bash stays denied.
    const result = applyToolProfile({ disallowedTools: ["Bash"] }, { kind: "custom", deny: ["Write"] });

    expect(result?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write"]));
  });

  it("preserves unrelated providerOptions and unrelated settings keys", () => {
    const result = applyToolProfile(
      {
        additionalDirectories: ["/srv"],
        sandbox: { enabled: true },
        settings: { permissions: { allow: ["Read(*)"] }, sandbox: { enabled: true } },
      },
      { kind: "orchestrator" },
    );

    expect(result?.additionalDirectories).toEqual(["/srv"]);
    expect(result?.sandbox).toEqual({ enabled: true });
    const settings = result?.settings as { permissions: { allow: string[] }; sandbox: unknown };
    expect(settings.sandbox).toEqual({ enabled: true });
    expect(settings.permissions.allow).toEqual(["Read(*)"]);
  });

  it("does not duplicate a tool the caller already denied", () => {
    const result = applyToolProfile({ disallowedTools: ["Bash"] }, { kind: "read-only" });

    const bashEntries = (result?.disallowedTools as string[]).filter((tool) => tool === "Bash");
    expect(bashEntries).toHaveLength(1);
  });

  it("a custom profile's allow list pre-approves tools without re-enabling denied ones", () => {
    const result = applyToolProfile(undefined, { kind: "custom", deny: ["Bash"], allow: ["Read"] });

    const permissions = (result?.settings as { permissions: { allow: string[]; deny: string[] } }).permissions;
    expect(permissions.allow).toEqual(["Read(*)"]);
    expect(result?.disallowedTools).toEqual(["Bash"]);
  });

  it("tolerates a malformed providerOptions value rather than throwing", () => {
    expect(() => applyToolProfile("nonsense", { kind: "read-only" })).not.toThrow();
    expect(applyToolProfile("nonsense", { kind: "read-only" })?.disallowedTools).toContain("Bash");
  });
});

describe("ToolProfileSchema", () => {
  it("rejects an unknown profile kind", () => {
    expect(ToolProfileSchema.safeParse({ kind: "god-mode" }).success).toBe(false);
  });

  it("rejects a tool name that isn't a plain identifier", () => {
    expect(ToolProfileSchema.safeParse({ kind: "custom", deny: ["Bash(rm -rf /)"] }).success).toBe(false);
  });

  it("accepts an MCP tool name", () => {
    expect(ToolProfileSchema.safeParse({ kind: "custom", deny: ["mcp__paseo__create_agent"] }).success).toBe(true);
  });
});
