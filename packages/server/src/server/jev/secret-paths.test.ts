import { describe, expect, test } from "vitest";

import { comparableName, isSecretShapedPath } from "./secret-paths.js";

describe("isSecretShapedPath: names built to look like secret ones", () => {
  test.each([
    "C:\\repo\\.env ",
    "C:\\repo\\.env.",
    "C:\\repo\\.env . .",
    "C:\\repo\\.env::$DATA",
    "C:\\repo\\.env:hidden",
    "C:\\repo\\.еnv",
    "C:\\repo\\．env",
    "C:\\repo\\ІD_RSA",
    "/repo/.env ",
    "/repo/.еnv",
    "/repo/config/secrets.json ",
    "/repo/.htpasswd::$DATA",
  ])("%j is secret-shaped", (name) => {
    expect(isSecretShapedPath(name)).toBe(true);
  });

  test.each([
    "C:\\repo\\README.md",
    "C:\\repo\\src\\environment.ts",
    "C:\\repo\\.envelope\\a.ts",
    "C:\\",
    "/repo/docs/env.md",
    "/repo/src/app.ts:12",
  ])("%j is not", (name) => {
    expect(isSecretShapedPath(name)).toBe(false);
  });

  test.each(["/repo/.e\u200Cnv", "/repo/.env\uFEFF"])(
    "%j is secret-shaped once its HFS+-ignored code point is stripped (verify finding, round 7)",
    (name) => {
      expect(isSecretShapedPath(name)).toBe(true);
    },
  );
});

describe("comparableName strips HFS+-ignored code points (verify finding, round 7)", () => {
  // HFS+ ignores these when comparing two names -- the same class of gap as git's
  // CVE-2014-9390 / core.protectHFS -- so a name built with one is the SAME file to the
  // filesystem even though it compares unequal as a plain string.
  test.each([
    ["zero width non-joiner, U+200C", ".g\u200Cit", ".git"],
    ["zero width joiner, U+200D", ".g\u200Dit", ".git"],
    ["left-to-right mark, U+200E", ".g\u200Eit", ".git"],
    ["right-to-left mark, U+200F", ".g\u200Fit", ".git"],
    ["left-to-right embedding, U+202A", ".g\u202Ait", ".git"],
    ["right-to-left override, U+202E", ".zsh\u202Erc", ".zshrc"],
    ["inhibit symmetric swapping, U+206A", ".g\u206Ait", ".git"],
    ["nominal digit shapes, U+206F", ".g\u206Fit", ".git"],
    ["zero width no-break space / BOM, U+FEFF", ".s\uFEFFsh", ".ssh"],
  ])("strips %s: %j -> %j", (_label, input, expected) => {
    expect(comparableName(input)).toBe(expected);
  });

  test("does NOT strip U+200B (zero width space) -- HFS+ does not ignore it", () => {
    const withZwsp = ".g\u200Bit";
    expect(comparableName(withZwsp)).toBe(withZwsp);
    expect(comparableName(withZwsp)).not.toBe(".git");
  });
});
