import { describe, expect, test } from "vitest";
import { extractExcerptText } from "./excerpt.js";

describe("extractExcerptText", () => {
  test("extracts text from a Claude SDK user message row", () => {
    const row = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "find the bug in auth.ts" }] },
    });
    expect(extractExcerptText(row, 200)).toEqual({ role: "user", text: "find the bug in auth.ts" });
  });

  test("extracts text from an assistant message with a tool_use block", () => {
    const row = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", name: "Read", input: { file_path: "auth.ts" } },
        ],
      },
    });
    const result = extractExcerptText(row, 200);
    expect(result?.role).toBe("assistant");
    expect(result?.text).toContain("Let me check.");
    expect(result?.text).toContain("[tool_use: Read]");
  });

  test("falls back to harvesting string leaves for an unknown row shape", () => {
    const row = JSON.stringify({
      kind: "rollout_item",
      payload: { note: "found the auth bug here" },
    });
    const result = extractExcerptText(row, 200);
    expect(result?.text).toContain("found the auth bug here");
  });

  test("never returns the raw JSON braces", () => {
    const row = JSON.stringify({ type: "user", message: { role: "user", content: "hello world" } });
    const result = extractExcerptText(row, 200);
    expect(result?.text).not.toMatch(/[{}]/);
  });

  test("truncates long text with an ellipsis", () => {
    const longText = "x".repeat(500);
    const row = JSON.stringify({ type: "user", message: { role: "user", content: longText } });
    const result = extractExcerptText(row, 50);
    expect(result?.text.length).toBe(50);
    expect(result?.text.endsWith("…")).toBe(true);
  });

  test("returns null for a line that is not JSON", () => {
    expect(extractExcerptText("not json at all", 200)).toBeNull();
  });

  test("returns null for an empty line", () => {
    expect(extractExcerptText("   ", 200)).toBeNull();
  });

  test("returns null when there is no string anywhere in the row", () => {
    const row = JSON.stringify({ count: 3, done: true });
    expect(extractExcerptText(row, 200)).toBeNull();
  });
});
