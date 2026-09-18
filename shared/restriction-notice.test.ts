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
    expect(restrictionNotice("unrestricted", [])).toBeUndefined();
    expect(restrictionNotice("write", [])).toBeUndefined();
  });

  it("names the denied native tools exactly for read-only", () => {
    const notice = restrictionNotice("read-only", profileDeniedTools({ kind: "read-only" })) as string;

    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
      expect(notice, `${tool} must be named`).toContain(tool);
    }
  });

  it("tells a read-only agent to report the change instead of making it", () => {
    const notice = restrictionNotice("read-only", profileDeniedTools({ kind: "read-only" })) as string;

    expect(notice).toMatch(/report/i);
    expect(notice).toMatch(/diff/i);
  });

  it("tells an orchestrator to delegate through create_agent", () => {
    const notice = restrictionNotice("orchestrator", profileDeniedTools({ kind: "orchestrator" })) as string;

    expect(notice).toContain("mcp__paseo__create_agent");
    for (const tool of ["Read", "Glob", "Grep", "Bash", "Task", "Agent"]) {
      expect(notice, `${tool} must be named`).toContain(tool);
    }
  });

  it("says the denial is not a permission prompt away, so the agent does not retry", () => {
    for (const kind of ["read-only", "orchestrator"] as const) {
      const notice = restrictionNotice(kind, profileDeniedTools({ kind })) as string;
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
      const notice = restrictionNotice(kind, profileDeniedTools({ kind })) as string;
      expect(approxTokens(notice), `${kind} notice is too expensive`).toBeLessThanOrEqual(90);
    }
  });

  it("enumerates a custom profile's own deny list", () => {
    const notice = restrictionNotice("custom", ["Bash", "WebFetch"]) as string;

    expect(notice).toContain("Bash, WebFetch");
  });

  it("summarizes past the enumeration cap rather than pasting a wall of tool names", () => {
    const many = Array.from({ length: MAX_ENUMERATED_TOOLS + 5 }, (_, index) => `Tool${index}`);

    const notice = restrictionNotice("custom", many) as string;

    expect(notice).toContain("Tool0");
    expect(notice).toContain("and 5 more");
    expect(notice).not.toContain(`Tool${MAX_ENUMERATED_TOOLS + 1}`);
  });

  it("falls back to describing what was actually applied when a built-in profile was widened", () => {
    const widened = [...profileDeniedTools({ kind: "read-only" }), "WebFetch"];

    const notice = restrictionNotice("read-only", widened) as string;

    expect(notice).toContain("WebFetch");
  });
});

describe("initialPromptWithNotice", () => {
  it("prepends rather than replaces: the caller's task survives verbatim", () => {
    const result = initialPromptWithNotice("Audit the auth flow.", "read-only", profileDeniedTools({ kind: "read-only" }));

    expect(result?.endsWith("\n\nAudit the auth flow.")).toBe(true);
    expect(result?.startsWith("[tool profile: read-only")).toBe(true);
  });

  it("leaves the prompt alone for an unrestricted profile", () => {
    expect(initialPromptWithNotice("Ship the feature.", "unrestricted", [])).toBeUndefined();
  });

  it("does not invent a prompt for a create that had none, which would start a turn nobody asked for", () => {
    expect(initialPromptWithNotice(undefined, "read-only", profileDeniedTools({ kind: "read-only" }))).toBeUndefined();
    expect(initialPromptWithNotice("   ", "read-only", profileDeniedTools({ kind: "read-only" }))).toBeUndefined();
  });
});
