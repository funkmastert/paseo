import { describe, it, expect } from "vitest";
import { arenaAliasFor } from "./arena-aliases";

describe("arena-aliases", () => {
  it("maps claude-sonnet-5.5-xhigh to claude-sonnet-5-5", () => {
    const alias = arenaAliasFor("claude-sonnet-5.5-xhigh");
    expect(alias).toEqual({ arenaName: "claude-sonnet-5.5-xhigh", ref: "claude-sonnet-5-5", effort: "xhigh" });
  });

  it("maps gpt-6-sol-max to codex/gpt-6-sol", () => {
    const alias = arenaAliasFor("gpt-6-sol-max");
    expect(alias).toEqual({ arenaName: "gpt-6-sol-max", ref: "codex/gpt-6-sol", effort: "max" });
  });

  it("returns undefined for unknown names", () => {
    const alias = arenaAliasFor("unknown-model-99");
    expect(alias).toBeUndefined();
  });

  it("is exact-match only", () => {
    // No fuzzy matching
    const alias1 = arenaAliasFor("claude-sonnet-5.5");
    const alias2 = arenaAliasFor("claude-sonnet-5.5-high");
    expect(alias1).toBeUndefined();
    expect(alias2).toEqual({ arenaName: "claude-sonnet-5.5-high", ref: "claude-sonnet-5-5", effort: "high" });
  });
});
