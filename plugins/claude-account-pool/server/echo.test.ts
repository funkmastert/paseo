import { describe, expect, it } from "vitest";
import { echoed, echoedList } from "./echo";

/** `String.prototype.isWellFormed` is ES2024; the plugin's lib stops at ES2023. */
function isWellFormed(value: string): boolean {
  return (value as unknown as { isWellFormed(): boolean }).isWellFormed();
}

describe("echoed", () => {
  it("leaves a value within the cap alone", () => {
    expect(echoed("x".repeat(120))).toBe("x".repeat(120));
  });

  it("cuts a longer value at the cap and ends it in an ellipsis", () => {
    expect(echoed("x".repeat(121))).toBe(`${"x".repeat(120)}…`);
  });

  it("never cuts a character in half: one straddling the cap is left out whole, so jq does not render U+FFFD", () => {
    const cut = echoed(`${"x".repeat(119)}\u{1F389}${"y".repeat(10)}`);
    expect(isWellFormed(cut)).toBe(true);
    expect(cut).toBe(`${"x".repeat(119)}…`);
  });

  it("keeps a character that ends exactly at the cap", () => {
    expect(echoed(`${"x".repeat(118)}\u{1F389}${"y".repeat(10)}`)).toBe(`${"x".repeat(118)}\u{1F389}…`);
  });
});

describe("echoedList", () => {
  it("quotes each value, and counts the ones past the first ten", () => {
    const values = Array.from({ length: 12 }, (_, index) => `s${index}`);
    expect(echoedList(values)).toBe(`${values.slice(0, 10).map((value) => `"${value}"`).join(", ")} and 2 more`);
  });

  it("keeps each quoted value well-formed", () => {
    expect(isWellFormed(echoedList([`${"x".repeat(119)}\u{1F389}`]))).toBe(true);
  });
});
