import { describe, expect, test, vi } from "vitest";
import { PhysicalDeviceDetection } from "./physical-device-detection.js";

function setup(enabled: { value: boolean }) {
  const order: string[] = [];
  const adb = {
    start: vi.fn(() => order.push("adb.start")),
    stop: vi.fn(() => order.push("adb.stop")),
    sweepOrphan: vi.fn(async () => {
      order.push("adb.sweepOrphan");
    }),
  };
  const devicectl = { start: vi.fn(), stop: vi.fn() };
  const onStopped = vi.fn();
  const detection = new PhysicalDeviceDetection({
    adb,
    devicectl,
    isEnabled: () => enabled.value,
    onStopped,
    logger: { warn: vi.fn() },
  });
  return { detection, adb, devicectl, onStopped, order };
}

describe("PhysicalDeviceDetection", () => {
  test("spawns nothing while device management is off, but still sweeps a crashed daemon's child", async () => {
    const { detection, adb, devicectl } = setup({ value: false });

    await detection.start();

    expect(adb.sweepOrphan).toHaveBeenCalled();
    expect(adb.start).not.toHaveBeenCalled();
    expect(devicectl.start).not.toHaveBeenCalled();
  });

  test("starts both sources after the sweep when on", async () => {
    const { detection, devicectl, order } = setup({ value: true });

    await detection.start();

    expect(order).toEqual(["adb.sweepOrphan", "adb.start"]);
    expect(devicectl.start).toHaveBeenCalled();
  });

  test("a config change turns detection on and off, clearing what it saw", async () => {
    const enabled = { value: false };
    const { detection, adb, devicectl, onStopped } = setup(enabled);
    await detection.start();

    enabled.value = true;
    detection.sync();
    expect(adb.start).toHaveBeenCalledTimes(1);
    expect(devicectl.start).toHaveBeenCalledTimes(1);

    enabled.value = false;
    detection.sync();
    expect(adb.stop).toHaveBeenCalled();
    expect(devicectl.stop).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalled();
  });

  test("nothing starts before start(), or after stop()", async () => {
    const { detection, adb } = setup({ value: true });

    detection.sync();
    expect(adb.start).not.toHaveBeenCalled();

    await detection.start();
    detection.stop();
    detection.sync();
    expect(adb.start).toHaveBeenCalledTimes(1);
  });
});
