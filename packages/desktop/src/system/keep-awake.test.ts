import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildCaffeinateArgs,
  createKeepAwakeController,
  type KeepAwakeChild,
  type KeepAwakeState,
} from "./keep-awake";

const APP_PID = 4242;

function state(overrides: Partial<KeepAwakeState["settings"]> = {}, onBatteryPower = false) {
  return {
    settings: { keepAwake: true, keepDisplayAwake: "always" as const, ...overrides },
    onBatteryPower,
  };
}

class FakeChild extends EventEmitter implements KeepAwakeChild {
  readonly signals: (NodeJS.Signals | undefined)[] = [];
  constructor(
    readonly pid: number,
    readonly args: string[],
  ) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

function createHarness() {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  let clock = 0;
  const controller = createKeepAwakeController({
    appPid: APP_PID,
    spawn: (args) => {
      const child = new FakeChild(1000 + children.length, args);
      children.push(child);
      return child;
    },
    now: () => clock,
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });
  return {
    controller,
    children,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("buildCaffeinateArgs", () => {
  it("asserts display, idle, disk and system sleep tied to the app pid", () => {
    expect(buildCaffeinateArgs({ ...state(), appPid: APP_PID })).toEqual(["-dims", "-w", "4242"]);
  });

  it("returns null when keep-awake is off", () => {
    expect(buildCaffeinateArgs({ ...state({ keepAwake: false }), appPid: APP_PID })).toBeNull();
  });

  it("drops -d when the display may sleep", () => {
    expect(buildCaffeinateArgs({ ...state({ keepDisplayAwake: "never" }), appPid: 1 })).toEqual([
      "-ims",
      "-w",
      "1",
    ]);
  });

  it("keeps the display awake on the power adapter only when asked to", () => {
    const onAdapter = state({ keepDisplayAwake: "on-power-adapter" }, false);
    const onBattery = state({ keepDisplayAwake: "on-power-adapter" }, true);
    expect(buildCaffeinateArgs({ ...onAdapter, appPid: 1 })?.[0]).toBe("-dims");
    expect(buildCaffeinateArgs({ ...onBattery, appPid: 1 })?.[0]).toBe("-ims");
  });
});

describe("createKeepAwakeController", () => {
  it("spawns one caffeinate and leaves it alone while nothing changes", () => {
    const { controller, children } = createHarness();
    controller.apply(state());
    controller.apply(state());
    expect(children).toHaveLength(1);
    expect(children[0]?.args).toEqual(["-dims", "-w", "4242"]);
  });

  it("replaces caffeinate when the assertions change", () => {
    const { controller, children } = createHarness();
    controller.apply(state({ keepDisplayAwake: "on-power-adapter" }, false));
    controller.apply(state({ keepDisplayAwake: "on-power-adapter" }, true));
    expect(children).toHaveLength(2);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(children[1]?.args[0]).toBe("-ims");
  });

  it("does not react to the exit of a caffeinate it replaced", () => {
    const { controller, children, advance } = createHarness();
    controller.apply(state({ keepDisplayAwake: "never" }));
    controller.apply(state());
    advance(60_000);
    children[0]?.emit("exit", null, "SIGTERM");
    expect(children).toHaveLength(2);
  });

  it("kills caffeinate when turned off and on stop", () => {
    const { controller, children } = createHarness();
    controller.apply(state());
    controller.apply(state({ keepAwake: false }));
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    controller.apply(state());
    controller.stop();
    expect(children[1]?.signals).toEqual(["SIGTERM"]);
    controller.apply(state());
    expect(children).toHaveLength(2);
  });

  it("respawns a caffeinate that was killed after running a while", () => {
    const { controller, children, advance } = createHarness();
    controller.apply(state());
    advance(60_000);
    children[0]?.emit("exit", null, "SIGKILL");
    expect(children).toHaveLength(2);
    expect(children[1]?.args).toEqual(["-dims", "-w", "4242"]);
  });

  it("gives up on a caffeinate that fails straight away", () => {
    const { controller, children, logs, advance } = createHarness();
    controller.apply(state());
    advance(50);
    children[0]?.emit("error", new Error("spawn caffeinate ENOENT"));
    expect(children).toHaveLength(1);
    expect(logs).toContain("[keep-awake] caffeinate exited unexpectedly");
    controller.apply(state());
    expect(children).toHaveLength(2);
  });
});

function caffeinateAssertionTypes(pid: number): string[] {
  const output = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
  const types: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*pid (\d+)\(caffeinate\): \[\w+\] [\d:]+ (\w+) /);
    if (match && Number(match[1]) === pid) {
      types.push(match[2] as string);
    }
  }
  return types.sort();
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

describe.runIf(process.platform === "darwin")("caffeinate on macOS", () => {
  it("holds the -dims assertions until the watched process exits", async () => {
    const watched = spawn("sleep", ["30"], { stdio: "ignore" });
    const watchedPid = watched.pid as number;
    const args = buildCaffeinateArgs({ ...state(), appPid: watchedPid }) as string[];
    const caffeinate = spawn("caffeinate", args, { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(caffeinateAssertionTypes(caffeinate.pid as number)).toEqual([
        "PreventDiskIdle",
        "PreventSystemSleep",
        "PreventUserIdleDisplaySleep",
        "PreventUserIdleSystemSleep",
      ]);

      watched.kill("SIGKILL");
      await waitForExit(caffeinate);
      expect(caffeinateAssertionTypes(caffeinate.pid as number)).toEqual([]);
    } finally {
      watched.kill("SIGKILL");
      caffeinate.kill("SIGKILL");
    }
  }, 15_000);
});
