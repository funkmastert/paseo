import { describe, expect, it } from "vitest";
import { acceptAgentDirectoryUpdate } from "./agent-directory-update-policy";

interface Sample {
  updatedAt: string;
  title: string;
  lastUsage?: { contextWindowUsedTokens: number };
}

const current: Sample = {
  updatedAt: "2026-09-14T10:00:00.000Z",
  title: "Fix the parser",
  lastUsage: { contextWindowUsedTokens: 100 },
};

describe("acceptAgentDirectoryUpdate", () => {
  it("adopts the first update for an unknown agent", () => {
    expect(acceptAgentDirectoryUpdate(undefined, current)).toBe(current);
  });

  it("keeps the previous identity when a same-timestamp update changes nothing", () => {
    // Streaming-only fields never bump updatedAt, so this is the shape of a redundant tick.
    const incoming: Sample = { ...current, lastUsage: { contextWindowUsedTokens: 100 } };
    expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(current);
  });

  it("adopts a same-timestamp update that changes something", () => {
    const incoming: Sample = { ...current, lastUsage: { contextWindowUsedTokens: 250 } };
    expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(incoming);
  });

  it("adopts a newer update even when its content matches", () => {
    const incoming: Sample = { ...current, updatedAt: "2026-09-14T10:00:01.000Z" };
    expect(acceptAgentDirectoryUpdate(current, incoming)).toBe(incoming);
  });

  it("only merges lastUsage from a stale update", () => {
    const stale: Sample = {
      updatedAt: "2026-09-14T09:00:00.000Z",
      title: "An old title",
      lastUsage: { contextWindowUsedTokens: 400 },
    };
    const result = acceptAgentDirectoryUpdate(current, stale);
    expect(result).toEqual({ ...current, lastUsage: { contextWindowUsedTokens: 400 } });
    expect(result).not.toBe(current);

    const staleSameUsage: Sample = { ...stale, lastUsage: { contextWindowUsedTokens: 100 } };
    expect(acceptAgentDirectoryUpdate(current, staleSameUsage)).toBe(current);
    expect(acceptAgentDirectoryUpdate(current, { ...stale, lastUsage: undefined })).toBe(current);
  });
});
