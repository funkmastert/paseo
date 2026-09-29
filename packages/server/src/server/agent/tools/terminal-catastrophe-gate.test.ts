import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolHostDependencies } from "./types.js";

/**
 * The catastrophe gate on the terminal route: `send_terminal_keys` types into a real shell, so a
 * line it submits is checked like a Bash call. Exercised through the real tool, so what this pins
 * is the wiring: the refused input never reaches the terminal, and the agent reads the denial.
 */
function createCatalog(terminalId: string, options: { gateEnabled?: boolean } = {}) {
  const send = vi.fn();
  const terminal = { id: terminalId, name: "t", cwd: "/tmp", send, kill: vi.fn() };
  const catalog = createPaseoToolCatalog({
    agentManager: { getPaseoToolPolicy: vi.fn(() => undefined) },
    agentStorage: { get: vi.fn(async () => null) },
    terminalManager: { getTerminal: vi.fn((id: string) => (id === terminalId ? terminal : null)) },
    ...(options.gateEnabled === false
      ? { daemonConfigStore: { get: () => ({ catastropheGate: { enabled: false } }) } }
      : {}),
    callerAgentId: "agent-1",
    logger: pino({ level: "silent" }),
  } as unknown as PaseoToolHostDependencies);
  const sendKeys = (keys: string, literal = true) =>
    catalog.executeTool("send_terminal_keys", { terminalId, keys, literal });
  return { sendKeys, send };
}

describe("send_terminal_keys catastrophe gate", () => {
  test("refuses a catastrophic line, and nothing reaches the terminal", async () => {
    const { sendKeys, send } = createCatalog("gate-one-call");

    await expect(sendKeys("rm -rf ~\r")).rejects.toThrow(/rule: rm-disk-root/);
    expect(send).not.toHaveBeenCalled();
  });

  test("refuses the Enter that submits a line typed in an earlier call, every time", async () => {
    const { sendKeys, send } = createCatalog("gate-split-enter");

    await sendKeys("git push -f origin main");
    expect(send).toHaveBeenCalledTimes(1);

    const denial = sendKeys("Enter", false);
    await expect(denial).rejects.toThrow(/rule: force-push-main/);
    await expect(denial).rejects.toThrow(/This block is final/);
    // The text is still at the prompt, so pressing Enter again is refused again.
    await expect(sendKeys("Enter", false)).rejects.toThrow(/force-push-main/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("passes ordinary input through", async () => {
    const { sendKeys, send } = createCatalog("gate-ordinary");

    await sendKeys("rm -rf node_modules && npm test\r");
    await sendKeys("cat > wipe.sh <<'EOF'\rrm -rf /\rEOF\r");

    expect(send).toHaveBeenCalledTimes(2);
  });

  test("the kill switch turns it off", async () => {
    const { sendKeys, send } = createCatalog("gate-off", { gateEnabled: false });

    await sendKeys("rm -rf ~\r");

    expect(send).toHaveBeenCalledWith({ type: "input", data: "rm -rf ~\r" });
  });
});
