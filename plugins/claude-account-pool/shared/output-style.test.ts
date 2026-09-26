import { describe, expect, it } from "vitest";
import { applyOutputStyle } from "./output-style";
import { applyToolProfile } from "./tool-profiles";

describe("applyOutputStyle", () => {
  it("changes nothing when there is no style, so an ordinary create stays byte-identical", () => {
    expect(applyOutputStyle(undefined, null)).toBeUndefined();
    const options = { settings: { permissions: { deny: ["Write"] } } };
    expect(applyOutputStyle(options, null)).toBe(options);
  });

  it("writes the style into settings", () => {
    expect(applyOutputStyle(undefined, "Concise")).toEqual({ settings: { outputStyle: "Concise" } });
  });

  it("merges with the deny tier rather than replacing it", () => {
    const denied = applyToolProfile(undefined, { kind: "read-only" }, [], "notice");
    const merged = applyOutputStyle(denied, "Concise") as {
      disallowedTools: string[];
      appendSystemPrompt: string;
      settings: { outputStyle: string; permissions: { deny: string[] } };
    };
    expect(merged.settings.outputStyle).toBe("Concise");
    expect(merged.settings.permissions.deny.length).toBeGreaterThan(0);
    expect(merged.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(merged.appendSystemPrompt).toBe("notice");
  });

  it("does not mutate the options it was given", () => {
    const options = { settings: { permissions: { deny: ["Write"] } } };
    applyOutputStyle(options, "Concise");
    expect(options).toEqual({ settings: { permissions: { deny: ["Write"] } } });
  });

  it("is idempotent when the same style is already set", () => {
    const options = { settings: { outputStyle: "Concise" } };
    expect(applyOutputStyle(options, "Concise")).toBe(options);
  });
});
