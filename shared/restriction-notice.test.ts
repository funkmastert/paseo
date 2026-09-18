import { describe, expect, it } from "vitest";
import { MAX_ENUMERATED_TOOLS, initialPromptWithNotice, restrictionNotice } from "./restriction-notice";
import { profileDeniedTools } from "./tool-profiles";

/**
 * Rough Claude-tokenizer proxy. English prose runs ~3.6 chars/token and the
 * notices are mostly prose with a handful of CamelCase tool names, so this
 * over- rather than under-estimates. Used to hold the line on the per-spawn
 * cost, not to be exact.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

describe("restrictionNotice", () => {
  it("says nothing for an unrestricted profile, so the common path costs zero tokens", () => {
    expect(restrictionNotice([])).toBeUndefined();
  });

  it("names the denied native tools exactly for read-only", () => {
    const notice = restrictionNotice(profileDeniedTools({ kind: "read-only" })) as string;

    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
      expect(notice, `${tool} must be named`).toContain(tool);
    }
  });

  it("tells a read-only agent to report the change instead of making it", () => {
    const notice = restrictionNotice(profileDeniedTools({ kind: "read-only" })) as string;

    expect(notice).toMatch(/report/i);
    expect(notice).toMatch(/diff/i);
  });

  it("tells an orchestrator to delegate through create_agent", () => {
    const notice = restrictionNotice(profileDeniedTools({ kind: "orchestrator" })) as string;

    expect(notice).toContain("mcp__paseo__create_agent");
    for (const tool of ["Read", "Glob", "Grep", "Bash", "Task", "Agent"]) {
      expect(notice, `${tool} must be named`).toContain(tool);
    }
  });

  it("says the denial is not a permission prompt away, so the agent does not retry", () => {
    for (const kind of ["read-only", "orchestrator"] as const) {
      const notice = restrictionNotice(profileDeniedTools({ kind })) as string;
      expect(notice).toMatch(/not gated, not requestable/);
    }
  });

  // ~80 tokens was the design target. `read-only` lands at ~84 and
  // `orchestrator` at ~89 under this deliberately pessimistic 3.6 chars/token
  // proxy; the overage is the ten native tool names `orchestrator` has to
  // spell out, which the "name the denied tools exactly" requirement demands.
  // The ceiling exists to catch drift, not to certify an exact figure.
  it("stays inside the per-spawn token budget", () => {
    for (const kind of ["read-only", "orchestrator"] as const) {
      const notice = restrictionNotice(profileDeniedTools({ kind })) as string;
      expect(approxTokens(notice), `${kind} notice is too expensive`).toBeLessThanOrEqual(90);
    }
  });

  it("enumerates a custom profile's own deny list", () => {
    const notice = restrictionNotice(["Bash", "WebFetch"]) as string;

    expect(notice).toContain("Bash, WebFetch");
  });

  it("summarizes past the enumeration cap rather than pasting a wall of tool names", () => {
    const many = Array.from({ length: MAX_ENUMERATED_TOOLS + 5 }, (_, index) => `Tool${index}`);

    const notice = restrictionNotice(many) as string;

    expect(notice).toContain("Tool0");
    expect(notice).toContain("and 5 more");
    expect(notice).not.toContain(`Tool${MAX_ENUMERATED_TOOLS + 1}`);
  });

  it("keeps the built-in copy and appends the extras when a built-in was widened", () => {
    const widened = [...profileDeniedTools({ kind: "read-only" }), "WebFetch"];

    const notice = restrictionNotice(widened) as string;

    expect(notice).toContain("[tool profile: read-only]");
    expect(notice).toContain("Also removed: WebFetch.");
  });

  it("uses the accurate built-in copy for a deny list that was inherited, not configured", () => {
    const notice = restrictionNotice(profileDeniedTools({ kind: "read-only" }), { inherited: true }) as string;

    expect(notice).toContain("[tool profile: read-only]");
    expect(notice).toMatch(/came from the agent that spawned you/);
  });
});

describe("initialPromptWithNotice", () => {
  it("prepends rather than replaces: the caller's task survives verbatim", () => {
    const result = initialPromptWithNotice("Audit the auth flow.", profileDeniedTools({ kind: "read-only" }));

    expect(result?.endsWith("\n\nAudit the auth flow.")).toBe(true);
    expect(result?.startsWith("[tool profile: read-only")).toBe(true);
  });

  it("leaves the prompt alone for an unrestricted profile", () => {
    expect(initialPromptWithNotice("Ship the feature.", [])).toBeUndefined();
  });

  it("does not invent a prompt for a create that had none, which would start a turn nobody asked for", () => {
    expect(initialPromptWithNotice(undefined, profileDeniedTools({ kind: "read-only" }))).toBeUndefined();
    expect(initialPromptWithNotice("   ", profileDeniedTools({ kind: "read-only" }))).toBeUndefined();
  });
});
