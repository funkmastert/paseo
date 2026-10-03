import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  readExecutableNameFromConfig,
  resolveExecutableNameFromContext,
} from "./executable-name.js";

const ENV_OVERRIDE = "PASEO_DESKTOP_EXECUTABLE_NAME";

describe("desktop packaged executable name resolution", () => {
  afterEach(() => {
    delete process.env[ENV_OVERRIDE];
  });

  test("reads the executable name straight out of electron-builder.yml", () => {
    const yml = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const configured = yml.match(/^executableName:\s*(.+)$/m)[1].trim();

    expect(readExecutableNameFromConfig()).toBe(configured);
  });

  test(`honors ${ENV_OVERRIDE} without touching electron-builder.yml`, () => {
    process.env[ENV_OVERRIDE] = "OverrideName";
    expect(readExecutableNameFromConfig()).toBe("OverrideName");
  });

  test("resolves via appInfo.productFilename when the packager has no explicit executableName (mac/win)", () => {
    const context = { packager: { appInfo: { productFilename: "Bozeo" } } };
    expect(resolveExecutableNameFromContext(context)).toBe("Bozeo");
  });

  test("prefers packager.executableName when present (Linux)", () => {
    const context = {
      packager: { executableName: "Bozeo", appInfo: { productFilename: "ignored" } },
    };
    expect(resolveExecutableNameFromContext(context)).toBe("Bozeo");
  });
});
