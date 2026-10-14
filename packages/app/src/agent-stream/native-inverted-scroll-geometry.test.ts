import { describe, expect, it } from "vitest";
import {
  offsetYToPseudoScrollTop,
  pseudoScrollTopToOffsetY,
} from "./native-inverted-scroll-geometry";

describe("native-inverted-scroll-geometry", () => {
  it("negates offsetY into a pseudo scroll-top", () => {
    expect(offsetYToPseudoScrollTop(0)).toBe(0);
    expect(offsetYToPseudoScrollTop(120)).toBe(-120);
  });

  it("negates a pseudo scroll-top back into offsetY", () => {
    expect(pseudoScrollTopToOffsetY(0)).toBe(0);
    expect(pseudoScrollTopToOffsetY(-120)).toBe(120);
  });

  it("round-trips through both conversions", () => {
    for (const offsetY of [0, 1, 42, 999]) {
      expect(pseudoScrollTopToOffsetY(offsetYToPseudoScrollTop(offsetY))).toBe(offsetY);
    }
  });
});
