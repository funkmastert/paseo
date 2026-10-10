import { describe, expect, it } from "vitest";
import { getAgentShortId } from "./agent-short-id";

describe("getAgentShortId", () => {
  it("matches the server's shortId convention", () => {
    expect(getAgentShortId("a73ccfd3f9c04e5f8b1234567890abcdef")).toBe("a73ccfd");
  });

  it("returns the whole id when it is shorter than the prefix", () => {
    expect(getAgentShortId("abc")).toBe("abc");
  });
});
