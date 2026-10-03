import { describe, expect, it } from "vitest";

import { createCatastropheCommandGate } from "./command-gate.js";

const noBranch = async () => null;

describe("createCatastropheCommandGate", () => {
  it("allows what the catastrophe gate allows", async () => {
    const gate = createCatastropheCommandGate({
      isEnabled: () => true,
      resolveCurrentBranch: noBranch,
    });
    await expect(gate({ command: "npm test", cwd: "/tmp/x" })).resolves.toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("refuses with the gate's denial when a Bash call would be refused", async () => {
    const gate = createCatastropheCommandGate({
      isEnabled: () => true,
      resolveCurrentBranch: noBranch,
    });
    const verdict = await gate({ command: "git push --force origin main", cwd: "/tmp/x" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("Blocked by the catastrophe gate");
  });

  it("asks git for the branch when a force push names no ref", async () => {
    const gate = createCatastropheCommandGate({
      isEnabled: () => true,
      resolveCurrentBranch: async () => "main",
    });
    const verdict = await gate({ command: "git push -f", cwd: "/tmp/x" });
    expect(verdict.allowed).toBe(false);
  });

  it("refuses when the gate throws", async () => {
    const gate = createCatastropheCommandGate({
      isEnabled: () => true,
      check: async () => {
        throw new Error("parser overflow");
      },
    });
    const verdict = await gate({ command: "echo hi", cwd: "/tmp/x" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("could not check this command");
  });

  it("honours agents.catastropheGate.enabled like the Bash hook", async () => {
    const gate = createCatastropheCommandGate({
      isEnabled: () => false,
      resolveCurrentBranch: noBranch,
    });
    const verdict = await gate({ command: "git push --force origin main", cwd: "/tmp/x" });
    expect(verdict).toEqual({ allowed: true, reason: null });
  });
});
