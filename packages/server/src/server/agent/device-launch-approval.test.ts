import { describe, expect, test, vi } from "vitest";
import {
  evaluateDeviceLaunchApproval,
  explainDeviceLaunchRefusal,
} from "./device-launch-approval.js";
import type { DeviceLaunchGate } from "./device-lease-manager.js";

function createLogger() {
  return { warn: vi.fn() };
}

describe("evaluateDeviceLaunchApproval", () => {
  test("returns the cap's message when the launch is refused", async () => {
    const gate: DeviceLaunchGate = {
      gateLaunch: vi.fn(async () => ({
        decision: "deny" as const,
        message: "no ios slot; call device_checkout",
      })),
    };

    await expect(
      evaluateDeviceLaunchApproval({
        gate,
        agentId: "agent-1",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
        logger: createLogger(),
      }),
    ).resolves.toBe("no ios slot; call device_checkout");
  });

  test("allows when the cap allows", async () => {
    const gate: DeviceLaunchGate = { gateLaunch: async () => ({ decision: "allow" as const }) };
    await expect(
      evaluateDeviceLaunchApproval({
        gate,
        agentId: "agent-1",
        command: "npm run typecheck",
        logger: createLogger(),
      }),
    ).resolves.toBeUndefined();
  });

  test("fails open on a missing gate, agent or command", async () => {
    const gateLaunch = vi.fn(async () => ({ decision: "deny" as const, message: "no" }));
    const gate: DeviceLaunchGate = { gateLaunch };
    const logger = createLogger();

    await expect(
      evaluateDeviceLaunchApproval({
        gate: undefined,
        agentId: "agent-1",
        command: "emulator -avd Pixel_7",
        logger,
      }),
    ).resolves.toBeUndefined();
    // Nobody to charge a slot to is not a reason to refuse work.
    await expect(
      evaluateDeviceLaunchApproval({
        gate,
        agentId: undefined,
        command: "emulator -avd Pixel_7",
        logger,
      }),
    ).resolves.toBeUndefined();
    for (const command of [undefined, null, "   "]) {
      await expect(
        evaluateDeviceLaunchApproval({ gate, agentId: "agent-1", command, logger }),
      ).resolves.toBeUndefined();
    }
    expect(gateLaunch).not.toHaveBeenCalled();
  });

  test("a cap that throws allows the command and says so in the log", async () => {
    // A device cap that breaks tool calls is worse than one that misses a device.
    const logger = createLogger();
    const gate: DeviceLaunchGate = {
      gateLaunch: async () => {
        throw new Error("ps timed out");
      },
    };

    await expect(
      evaluateDeviceLaunchApproval({
        gate,
        agentId: "agent-1",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
      expect.stringContaining("allowing the command"),
    );
  });
});

describe("explainDeviceLaunchRefusal", () => {
  test("delivers the reason the protocol could not carry back to the model", async () => {
    const explainRefusalToAgent = vi.fn(async () => undefined);
    explainDeviceLaunchRefusal({
      gate: { gateLaunch: async () => ({ decision: "allow" }), explainRefusalToAgent },
      agentId: "agent-1",
      message: "no ios slot",
      logger: createLogger(),
    });

    await vi.waitFor(() =>
      expect(explainRefusalToAgent).toHaveBeenCalledWith({
        agentId: "agent-1",
        message: "no ios slot",
      }),
    );
  });

  test("a gate that cannot explain, or a steer that fails, never becomes a thrown error", async () => {
    const logger = createLogger();
    // A gate with no explain channel at all — Claude's hook answers in band.
    expect(() =>
      explainDeviceLaunchRefusal({
        gate: { gateLaunch: async () => ({ decision: "allow" }) },
        agentId: "agent-1",
        message: "no ios slot",
        logger,
      }),
    ).not.toThrow();

    explainDeviceLaunchRefusal({
      gate: {
        gateLaunch: async () => ({ decision: "allow" }),
        explainRefusalToAgent: async () => {
          throw new Error("agent is gone");
        },
      },
      agentId: "agent-1",
      message: "no ios slot",
      logger,
    });
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "agent-1" }),
        expect.stringContaining("why its device launch was refused"),
      ),
    );
  });
});
