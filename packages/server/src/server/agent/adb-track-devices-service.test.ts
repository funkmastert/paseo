import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AdbTrackDevicesService } from "./adb-track-devices-service.js";

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.from(body.length.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, body]);
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
  removeAllListeners(event?: string) {
    super.removeAllListeners(event);
    this.stdout.removeAllListeners();
    return this;
  }
}

const logger = { info: vi.fn(), warn: vi.fn() };

describe("AdbTrackDevicesService", () => {
  test("delivers a parsed device list for each frame from the child", () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnProcess>;
    });
    const onDevicesChanged = vi.fn();
    const service = new AdbTrackDevicesService({ onDevicesChanged, logger, spawnProcess });

    service.start();
    expect(spawnProcess).toHaveBeenCalledWith("adb", ["track-devices", "-l"]);
    children[0]?.stdout.emit("data", frame("FAKESERIAL0001 device product:x\n"));

    expect(onDevicesChanged).toHaveBeenCalledTimes(1);
    expect(onDevicesChanged.mock.calls[0]?.[0]).toMatchObject([{ serial: "FAKESERIAL0001" }]);
    service.stop();
  });

  test("restarts the child with backoff when it exits unexpectedly", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnProcess>;
    });
    const service = new AdbTrackDevicesService({
      onDevicesChanged: vi.fn(),
      logger,
      spawnProcess,
      restartDelaysMs: [1_000],
    });

    service.start();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    children[0]?.emit("exit", 1, null);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    service.stop();
    vi.useRealTimers();
  });

  test("an ENOENT (adb not installed) stays quiet and does not retry", () => {
    vi.useFakeTimers();
    const spawnProcess = vi.fn(() => {
      const error = new Error("spawn adb ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const service = new AdbTrackDevicesService({ onDevicesChanged: vi.fn(), logger, spawnProcess });

    service.start();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    service.stop();
    vi.useRealTimers();
  });

  test("stop() prevents a scheduled restart from spawning again", () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnProcess>;
    });
    const service = new AdbTrackDevicesService({
      onDevicesChanged: vi.fn(),
      logger,
      spawnProcess,
      restartDelaysMs: [1_000],
    });

    service.start();
    children[0]?.emit("exit", 1, null);
    service.stop();
    vi.advanceTimersByTime(60_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("stop() kills the live child", () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawnProcess>;
    });
    const service = new AdbTrackDevicesService({ onDevicesChanged: vi.fn(), logger, spawnProcess });

    service.start();
    service.stop();
    expect(children[0]?.killed).toBe(true);
  });
});

describe("AdbTrackDevicesService review fixes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(extra: Partial<ConstructorParameters<typeof AdbTrackDevicesService>[0]> = {}) {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      Object.assign(child, { pid: 4242 + children.length });
      children.push(child);
      return child as unknown as ReturnType<typeof spawnProcess>;
    });
    const onDevicesChanged = vi.fn();
    const service = new AdbTrackDevicesService({
      onDevicesChanged,
      logger,
      spawnProcess,
      restartDelaysMs: [1_000, 30_000],
      ...extra,
    });
    return { service, children, spawnProcess, onDevicesChanged };
  }

  test("a child that emits both error and exit restarts once, not twice", () => {
    vi.useFakeTimers();
    const { service, children, spawnProcess } = setup();
    service.start();
    children[0]?.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    children[0]?.emit("exit", 1, null);

    vi.advanceTimersByTime(60_000);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    service.stop();
    vi.useRealTimers();
  });

  test("a healthy frame resets the backoff", () => {
    vi.useFakeTimers();
    const { service, children, spawnProcess } = setup();
    service.start();
    children[0]?.emit("exit", 1, null);
    vi.advanceTimersByTime(1_000);
    children[1]?.stdout.emit("data", frame(""));
    children[1]?.emit("exit", 1, null);

    vi.advanceTimersByTime(1_000);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    service.stop();
    vi.useRealTimers();
  });

  test("a child that dies clears the device list until the next one reports", () => {
    vi.useFakeTimers();
    const { service, children, onDevicesChanged } = setup();
    service.start();
    children[0]?.stdout.emit("data", frame("FAKESERIAL0001 device product:x\n"));
    children[0]?.emit("exit", 1, null);

    expect(onDevicesChanged).toHaveBeenLastCalledWith([]);
    service.stop();
    vi.useRealTimers();
  });

  test("start() kills a track-devices child a crashed daemon left behind, and only that", async () => {
    const files = new Map<string, string>([["pid", "777"]]);
    const killed: number[] = [];
    const { service } = setup({
      pidFile: {
        read: async () => files.get("pid"),
        write: async (value) => {
          files.set("pid", value);
        },
        remove: async () => {
          files.delete("pid");
        },
      },
      readProcessCommand: async (pid) => (pid === 777 ? "adb track-devices -l" : undefined),
      killProcess: (pid) => killed.push(pid),
    });

    await service.sweepOrphan();
    expect(killed).toEqual([777]);

    files.set("pid", "778");
    await service.sweepOrphan();
    expect(killed).toEqual([777]);
    service.stop();
  });

  test("the live child's pid is recorded for the next start to find", async () => {
    const files = new Map<string, string>();
    const { service } = setup({
      pidFile: {
        read: async () => files.get("pid"),
        write: async (value) => {
          files.set("pid", value);
        },
        remove: async () => {
          files.delete("pid");
        },
      },
    });
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.get("pid")).toBe("4242");
    service.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.has("pid")).toBe(false);
  });
});
