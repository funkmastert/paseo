import { describe, expect, test } from "vitest";

import { isSecretShapedPath } from "./secret-paths.js";

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
});
