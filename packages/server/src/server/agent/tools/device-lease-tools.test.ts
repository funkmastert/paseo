import { describe, expect, test, vi } from "vitest";
import type { DeviceCheckoutInput, DeviceStatusSnapshot } from "../device-lease-manager.js";
import { registerDeviceLeaseTools } from "./device-lease-tools.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

type Handler = (input: never, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;

function snapshot(overrides: Partial<DeviceStatusSnapshot> = {}): DeviceStatusSnapshot {
  return {
    enabled: true,
    dryRun: false,
    totalSlots: 3,
    slotsPerPlatform: 2,
    used: 2,
    usedByPlatform: { ios: 2, android: 0 },
    devices: [
      {
        platform: "ios",
        deviceId: "A0A912ED-C766-4778-957C-F9680C7309F3",
        state: "running",
        attribution: "lease",
        agentId: "agent-1",
        heldForSeconds: 600,
      },
      {
        platform: "ios",
        deviceId: "1A9C8E3A-A8AC-4FAB-9286-D970E0F83945",
        state: "running",
        attribution: "none",
        heldForSeconds: 8040,
      },
    ],
    waiting: [],
    blocked: [],
    generatedAt: "2026-09-18T16:00:00.000Z",
    ...overrides,
  };
}

function registerFor(callerAgentId: string | undefined) {
  const tools = new Map<string, Handler>();
  const checkout = vi.fn(async (_input: DeviceCheckoutInput) => ({
    status: "granted" as const,
    leaseId: "lease-1",
    platform: "ios" as const,
  }));
  const checkin = vi.fn(async () => 1);
  const getSnapshot = vi.fn(async () => snapshot());

  registerDeviceLeaseTools({
    registerTool: (name: string, _config: PaseoToolConfig, handler: Handler) => {
      tools.set(name, handler);
    },
    manager: { checkout, checkin, getSnapshot },
    ...(callerAgentId ? { callerAgentId } : {}),
  });

  return { tools, checkout, checkin, getSnapshot };
}

async function call(
  tools: Map<string, Handler>,
  name: string,
  input: unknown,
  context: PaseoToolExecutionContext = {},
): Promise<{ result: PaseoToolResult; payload: Record<string, unknown> }> {
  const handler = tools.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  const result = await handler(input as never, context);
  return { result, payload: result.structuredContent as Record<string, unknown> };
}

describe("registerDeviceLeaseTools", () => {
  test("offers the three tools an agent needs to share devices", () => {
    expect([...registerFor("agent-1").tools.keys()]).toEqual([
      "device_checkout",
      "device_checkin",
      "device_status",
    ]);
  });

  test("checkout waits by default — queueing beats being refused", async () => {
    const { tools, checkout } = registerFor("agent-1");

    await call(tools, "device_checkout", { platform: "ios", reason: "run the UI tests" });

    expect(checkout).toHaveBeenCalledWith({
      agentId: "agent-1",
      platform: "ios",
      wait: true,
      reason: "run the UI tests",
    });
  });

  test("a canceled turn stops waiting for a slot it will never use", async () => {
    const { tools, checkout } = registerFor("agent-1");
    const controller = new AbortController();

    await call(
      tools,
      "device_checkout",
      { platform: "android", wait: true, timeoutMinutes: 5 },
      { signal: controller.signal },
    );

    expect(checkout).toHaveBeenCalledWith({
      agentId: "agent-1",
      platform: "android",
      wait: true,
      timeoutMs: 300_000,
      signal: controller.signal,
    });
  });

  test("an unavailable slot is reported as a tool error, not a silent success", async () => {
    const tools = new Map<string, Handler>();
    registerDeviceLeaseTools({
      registerTool: (name: string, _config: PaseoToolConfig, handler: Handler) => {
        tools.set(name, handler);
      },
      manager: {
        checkout: async () => ({
          status: "unavailable" as const,
          platform: "ios" as const,
          message: "the machine is already running 2 ios devices (3 of 3 slots in use)",
        }),
        checkin: async () => 0,
        getSnapshot: async () => snapshot(),
      },
      callerAgentId: "agent-1",
    });

    const { result, payload } = await call(tools, "device_checkout", {
      platform: "ios",
      wait: false,
    });

    // The agent has to see this as a failure, or it carries on and boots a device anyway.
    expect(result.isError).toBe(true);
    expect(payload.message).toContain("3 of 3 slots in use");
  });

  test("check-in releases every slot the agent holds by default", async () => {
    const { tools, checkin } = registerFor("agent-1");

    const { payload } = await call(tools, "device_checkin", {});

    expect(checkin).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(payload).toEqual({ released: 1 });
  });

  test("status reports the count from the process scan, unleased devices included", async () => {
    const { tools } = registerFor("agent-1");

    const { payload } = await call(tools, "device_status", {});

    expect(payload.summary).toBe("2 of 3 device slots in use (2 running, 2 max per platform).");
    expect(payload.devices).toHaveLength(2);
  });

  test("refuses to guess which agent is asking", async () => {
    const { tools, checkout } = registerFor(undefined);

    const { result } = await call(tools, "device_checkout", { platform: "ios" });

    expect(result.isError).toBe(true);
    expect(checkout).not.toHaveBeenCalled();
  });
});
