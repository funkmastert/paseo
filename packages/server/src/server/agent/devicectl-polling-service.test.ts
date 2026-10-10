import { writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { DevicectlPollingService } from "./devicectl-polling-service.js";

const logger = { info: vi.fn(), warn: vi.fn() };

function fakeDevicesJson() {
  return JSON.stringify({
    result: {
      devices: [
        {
          hardwareProperties: {
            reality: "physical",
            udid: "00001234-FAKE-UDID-0001",
            deviceType: "iPhone",
            marketingName: "Fake iPhone",
          },
          connectionProperties: { transportType: "wired" },
        },
      ],
    },
  });
}

describe("DevicectlPollingService", () => {
  test("polls immediately on start and delivers parsed devices", async () => {
    const onDevicesChanged = vi.fn();
    const runDevicectl = vi.fn(async (outputPath: string) => {
      await writeFile(outputPath, fakeDevicesJson());
    });
    const service = new DevicectlPollingService({
      onDevicesChanged,
      logger,
      runDevicectl,
      platform: "darwin",
    });

    service.start();
    await vi.waitFor(() => expect(onDevicesChanged).toHaveBeenCalledTimes(1));
    expect(onDevicesChanged.mock.calls[0]?.[0]).toMatchObject([
      { udid: "00001234-FAKE-UDID-0001" },
    ]);
    service.stop();
  });

  test("polls again on the interval", async () => {
    const onDevicesChanged = vi.fn();
    const runDevicectl = vi.fn(async (outputPath: string) => {
      await writeFile(outputPath, fakeDevicesJson());
    });
    const service = new DevicectlPollingService({
      onDevicesChanged,
      logger,
      runDevicectl,
      platform: "darwin",
      intervalMs: 20,
    });

    service.start();
    await vi.waitFor(() => expect(onDevicesChanged.mock.calls.length).toBeGreaterThanOrEqual(2));
    service.stop();
  });

  test("never starts on a non-darwin platform", async () => {
    const runDevicectl = vi.fn(async () => undefined);
    const service = new DevicectlPollingService({
      onDevicesChanged: vi.fn(),
      logger,
      runDevicectl,
      platform: "linux",
    });

    service.start();
    expect(service.isRunning).toBe(false);
    expect(runDevicectl).not.toHaveBeenCalled();
  });

  test("an ENOENT (Xcode tools missing) stops polling for good", async () => {
    const error = new Error("spawn xcrun ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    const runDevicectl = vi.fn(async () => {
      throw error;
    });
    const service = new DevicectlPollingService({
      onDevicesChanged: vi.fn(),
      logger,
      runDevicectl,
      platform: "darwin",
      intervalMs: 10,
    });

    service.start();
    await vi.waitFor(() => expect(service.isRunning).toBe(false));
    const callsAfterStop = runDevicectl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runDevicectl.mock.calls.length).toBe(callsAfterStop);
  });

  test("a transient failure is retried next interval, not fatal", async () => {
    let attempt = 0;
    const runDevicectl = vi.fn(async (outputPath: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      await writeFile(outputPath, fakeDevicesJson());
    });
    const onDevicesChanged = vi.fn();
    const service = new DevicectlPollingService({
      onDevicesChanged,
      logger,
      runDevicectl,
      platform: "darwin",
      intervalMs: 10,
    });

    service.start();
    await vi.waitFor(() => expect(onDevicesChanged).toHaveBeenCalled());
    service.stop();
  });

  test("stop() halts further polling", async () => {
    const runDevicectl = vi.fn(async (outputPath: string) => {
      await writeFile(outputPath, fakeDevicesJson());
    });
    const service = new DevicectlPollingService({
      onDevicesChanged: vi.fn(),
      logger,
      runDevicectl,
      platform: "darwin",
      intervalMs: 10,
    });

    service.start();
    await vi.waitFor(() => expect(runDevicectl).toHaveBeenCalled());
    service.stop();
    // A poll already in flight when stop() lands can still complete once; what matters is that
    // no *new* one starts. Settle first, then compare two measurements taken after that.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const settledCalls = runDevicectl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runDevicectl.mock.calls.length).toBe(settledCalls);
  });
});
