import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { resolvePaseoHome } from "./paseo-home";

describe("resolvePaseoHome", () => {
  it("defaults to ~/.paseo", () => {
    expect(resolvePaseoHome({})).toBe(path.join(os.homedir(), ".paseo"));
  });

  it("expands a tilde-relative PASEO_HOME", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "~/custom-home" })).toBe(path.join(os.homedir(), "custom-home"));
  });

  it("resolves an absolute PASEO_HOME unchanged", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "/tmp/paseo-test-home" })).toBe(path.resolve("/tmp/paseo-test-home"));
  });
});
