/**
 * The cooperative half of the device cap: an agent says what it wants before it boots anything,
 * and waits for a slot instead of being refused at the launch point. Registered into the Paseo
 * MCP catalog like registerBrowserTools, so every provider gets them, not just Claude.
 *
 * These tools are a convention, not a control — an agent can skip them. What makes them worth
 * calling is the gate in front of the shell command, which refuses a device launch that never
 * checked out and names these tools in the refusal. How strong that gate is depends on the
 * provider (device-launch-enforcement.ts), so `device_status` tells the agent asking exactly
 * what the cap can do about *its* launches — an agent nothing refuses needs to know these
 * tools are the only thing holding the cap, and an agent that would be refused needs to know
 * checking out is how it avoids that.
 *
 * See docs/device-leases.md.
 */

import { z } from "zod";
import {
  describeDeviceLaunchEnforcement,
  resolveDeviceLaunchEnforcement,
} from "../device-launch-enforcement.js";
import type { DeviceLeaseManager, DeviceStatusSnapshot } from "../device-lease-manager.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export interface RegisterDeviceLeaseToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  manager: Pick<DeviceLeaseManager, "checkout" | "checkin" | "getSnapshot">;
  callerAgentId?: string;
  /** Throws when the caller is gone, so it is resolved lazily at each call, not at register. */
  resolveCallerProvider?: () => string | undefined;
}

const PlatformSchema = z.enum(["ios", "android"]);

const NO_AGENT_MESSAGE =
  "Device checkout needs to know which agent is asking, and this session has no agent id.";

function toResult(payload: unknown, isError = false): PaseoToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function summarize(snapshot: DeviceStatusSnapshot): string {
  if (!snapshot.enabled) return "The device cap is off; nothing is limiting devices.";
  const running = snapshot.devices.filter((device) => device.state === "running").length;
  return `${snapshot.used} of ${snapshot.totalSlots} device slots in use (${running} running, ${snapshot.slotsPerPlatform} max per platform).`;
}

export function registerDeviceLeaseTools(options: RegisterDeviceLeaseToolsOptions): void {
  const { manager, callerAgentId } = options;

  /** What the cap can do about the calling agent's own device launches, in one sentence. */
  const describeCallerEnforcement = (): { tier: string; detail: string } | undefined => {
    let provider: string | undefined;
    try {
      provider = options.resolveCallerProvider?.();
    } catch {
      // The caller is gone. The cap has nothing to tell it.
      return undefined;
    }
    if (!provider) return undefined;
    const enforcement = resolveDeviceLaunchEnforcement(provider);
    return { tier: enforcement.tier, detail: describeDeviceLaunchEnforcement(enforcement) };
  };

  // "Booting without checking out is refused" is true for Claude and OpenCode and a lie for
  // Pi, so the sentence that follows is the caller's own (device-launch-enforcement.ts).
  const checkoutConsequence =
    describeCallerEnforcement()?.detail ??
    "Booting a device without checking out may be refused, and always fills a slot either way.";

  options.registerTool(
    "device_checkout",
    {
      title: "Check out a device slot",
      description:
        "Claim one of the machine's limited iOS simulator / Android emulator slots before booting a device. " +
        "Waits for a slot when they are all taken (the usual case — the work is right, just early) and returns " +
        `as soon as one frees. ${checkoutConsequence} Call device_checkin when done.`,
      inputSchema: {
        platform: PlatformSchema.describe("ios for a simulator, android for an emulator."),
        reason: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("What the device is for. Shown to Tyler in the device status UI."),
        wait: z
          .boolean()
          .optional()
          .describe("Wait for a slot instead of returning immediately. Defaults to true."),
        timeoutMinutes: z.number().positive().max(120).optional(),
      },
    },
    async (input, context) => {
      if (!callerAgentId) return toResult({ error: NO_AGENT_MESSAGE }, true);
      const result = await manager.checkout({
        agentId: callerAgentId,
        platform: input.platform,
        wait: input.wait ?? true,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.timeoutMinutes ? { timeoutMs: input.timeoutMinutes * 60_000 } : {}),
        // A canceled turn must not leave an agent queued for a slot it will never use.
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return toResult(result, result.status === "unavailable");
    },
  );

  options.registerTool(
    "device_checkin",
    {
      title: "Check a device slot back in",
      description:
        "Give back a device slot as soon as you are finished with the device, so a waiting agent can have it. " +
        "Shut the device down too — the slot is also freed automatically when the device stops or the agent ends.",
      inputSchema: {
        leaseId: z.string().optional().describe("Defaults to every slot this agent holds."),
      },
    },
    async (input) => {
      if (!callerAgentId) return toResult({ error: NO_AGENT_MESSAGE }, true);
      const released = await manager.checkin({
        agentId: callerAgentId,
        ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      });
      return toResult({ released });
    },
  );

  options.registerTool(
    "device_status",
    {
      title: "Show running devices",
      description:
        "Every iOS simulator and Android emulator running on this machine, who holds each one and for how long, " +
        "and how they count against the cap. Counted from the process list, so devices nobody checked out are included. " +
        "Also says what the cap can and cannot do about your own device launches, which depends on which agent you are.",
      inputSchema: {},
    },
    async () => {
      const snapshot = await manager.getSnapshot();
      const enforcement = describeCallerEnforcement();
      return toResult({
        summary: summarize(snapshot),
        ...snapshot,
        ...(enforcement ? { yourEnforcement: enforcement } : {}),
      });
    },
  );
}
