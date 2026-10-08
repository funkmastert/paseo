import { describe, expect, test } from "vitest";

import { normalizeTitle, singleLine, yamlScalar } from "./text.js";

const HOSTILE_LENGTH = 640 * 1024;

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("singleLine", () => {
  test("collapses whitespace runs and newlines to single spaces", () => {
    expect(singleLine("  Ship\tbehind\n\n a   flag \r\n")).toBe("Ship behind a flag");
  });

  test("640 KB of alternating whitespace and letters finishes in under 100 ms", () => {
    const hostile = " \t\na".repeat(HOSTILE_LENGTH / 4);
    expect(timed(() => singleLine(hostile))).toBeLessThan(100);
  });
});

describe("normalizeTitle", () => {
  test("drops case, punctuation and platform words", () => {
    expect(normalizeTitle("Checkout Redesign (Android)")).toBe("checkout redesign");
    expect(normalizeTitle("iOS app: checkout-redesign!")).toBe("checkout redesign");
  });

  test("640 KB of alternating punctuation and letters finishes in under 100 ms", () => {
    const hostile = "-.a(".repeat(HOSTILE_LENGTH / 4);
    expect(timed(() => normalizeTitle(hostile))).toBeLessThan(100);
  });
});

describe("yamlScalar", () => {
  test("leaves plain titles bare and quotes anything YAML would misread", () => {
    expect(yamlScalar("Checkout redesign (Android)")).toBe("Checkout redesign (Android)");
    expect(yamlScalar("Checkout: v2")).toBe('"Checkout: v2"');
    expect(yamlScalar('# "quoted"')).toBe('"# \\"quoted\\""');
  });

  test("640 KB of plain text ending in a character that forces quoting finishes in under 100 ms", () => {
    const hostile = `${"a ".repeat(HOSTILE_LENGTH / 2)}:`;
    expect(timed(() => yamlScalar(hostile))).toBeLessThan(100);
  });
});
