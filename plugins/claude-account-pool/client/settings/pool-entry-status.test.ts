import { describe, expect, it } from "vitest";
import { poolEntryStatus, poolEntryWarning } from "./pool-entry-status";

const CATALOG = { claude: ["claude-sonnet-5", "claude-haiku-4-5"], codex: ["gpt-5"] };

describe("poolEntryStatus", () => {
  it("is listed when the catalog carries the exact id", () => {
    expect(poolEntryStatus("claude-sonnet-5", CATALOG, [])).toEqual({ kind: "listed" });
    expect(poolEntryStatus("codex/gpt-5", CATALOG, [])).toEqual({ kind: "listed" });
  });

  it("resolves a dated snapshot to the catalog's spelling", () => {
    expect(poolEntryStatus("claude-haiku-4-5-20251001", CATALOG, [])).toEqual({
      kind: "resolved",
      id: "claude-haiku-4-5",
    });
  });

  it("is unadvertised when no spelling is listed, and says whether the allowlist vouches for it", () => {
    expect(poolEntryStatus("claude-opus-5-5", CATALOG, [])).toEqual({ kind: "unadvertised", allowlisted: false });
    expect(poolEntryStatus("claude-opus-5-5", CATALOG, ["claude-opus-5-5"])).toEqual({
      kind: "unadvertised",
      allowlisted: true,
    });
  });

  it("is unknown until the family's catalog has loaded, so a slow load is not a false alarm", () => {
    expect(poolEntryStatus("claude-opus-5-5", { codex: ["gpt-5"] }, [])).toEqual({ kind: "unknown" });
  });
});

describe("poolEntryWarning", () => {
  it("is silent for a listed, resolved or unknown entry", () => {
    expect(poolEntryWarning({ kind: "listed" })).toBeUndefined();
    expect(poolEntryWarning({ kind: "unknown" })).toBeUndefined();
    expect(poolEntryWarning({ kind: "resolved", id: "claude-haiku-4-5" })).toContain("claude-haiku-4-5");
  });

  it("says an unlisted, unvouched entry never runs, and how to change that", () => {
    const warning = poolEntryWarning({ kind: "unadvertised", allowlisted: false });
    expect(warning).toContain("NEVER RUNS");
    expect(warning).toContain("allowUnlistedModels");
  });

  it("marks an allowlisted one unverified rather than dead", () => {
    expect(poolEntryWarning({ kind: "unadvertised", allowlisted: true })).toContain("UNVERIFIED");
  });
});
