// Keeps the Mac awake while Bozeo runs by holding a `caffeinate` child.
//
// Electron's powerSaveBlocker only reaches two IOPM assertions, one at a time:
// "prevent-app-suspension" is NoIdleSleepAssertion (caffeinate -i) and
// "prevent-display-sleep" is NoDisplaySleepAssertion (caffeinate -d). Neither
// reaches PreventDiskIdle (-m) or PreventSystemSleep (-s), so this spawns
// caffeinate instead. `-w <app pid>` makes caffeinate exit when the app does,
// even if the app is SIGKILLed, so no assertion outlives Bozeo.
//
// App Nap is not what this guards against. RunningBoard assigns darwin roles
// (and so App Nap) to the app bundle's own processes; the daemon is a plain
// spawned child it never tracks. The daemon suspensions seen in practice were
// system sleep: lid close and the dark wakes that follow.

import type { ChildProcess } from "node:child_process";

export type KeepDisplayAwake = "always" | "on-power-adapter" | "never";

export interface KeepAwakeSettings {
  keepAwake: boolean;
  keepDisplayAwake: KeepDisplayAwake;
}

export interface KeepAwakeState {
  settings: KeepAwakeSettings;
  onBatteryPower: boolean;
}

export type KeepAwakeChild = Pick<ChildProcess, "pid" | "kill" | "once">;

export interface KeepAwakeLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface KeepAwakeController {
  apply(state: KeepAwakeState): void;
  stop(): void;
}

// A caffeinate that dies sooner than this after spawning is not respawned: the
// binary is missing or rejecting its arguments, and retrying would spin.
const MIN_HEALTHY_RUN_MS = 10_000;

export function buildCaffeinateArgs(input: KeepAwakeState & { appPid: number }): string[] | null {
  const { settings, onBatteryPower, appPid } = input;
  if (!settings.keepAwake) {
    return null;
  }
  const keepDisplayAwake =
    settings.keepDisplayAwake === "always" ||
    (settings.keepDisplayAwake === "on-power-adapter" && !onBatteryPower);
  // -i idle system sleep, -m disk idle sleep, -s system sleep (macOS honours
  // -s on AC power only), -d display sleep.
  return [keepDisplayAwake ? "-dims" : "-ims", "-w", String(appPid)];
}

export function createKeepAwakeController(deps: {
  appPid: number;
  spawn: (args: string[]) => KeepAwakeChild;
  now?: () => number;
  log: KeepAwakeLogger;
}): KeepAwakeController {
  const now = deps.now ?? Date.now;
  let child: KeepAwakeChild | null = null;
  let childArgs: string[] | null = null;
  let lastState: KeepAwakeState | null = null;
  let stopped = false;

  function killChild(): void {
    const current = child;
    child = null;
    childArgs = null;
    current?.kill("SIGTERM");
  }

  function spawnChild(args: string[]): void {
    const spawned = deps.spawn(args);
    const startedAt = now();
    child = spawned;
    childArgs = args;
    deps.log.info("[keep-awake] caffeinate started", { pid: spawned.pid ?? null, args });

    const onGone = (details: Record<string, unknown>) => {
      if (child !== spawned) {
        return;
      }
      child = null;
      childArgs = null;
      const ranForMs = now() - startedAt;
      deps.log.warn("[keep-awake] caffeinate exited unexpectedly", { ...details, ranForMs });
      if (!stopped && lastState && ranForMs >= MIN_HEALTHY_RUN_MS) {
        apply(lastState);
      }
    };
    spawned.once("exit", (code, signal) => onGone({ code, signal }));
    spawned.once("error", (error) => onGone({ error: error.message }));
  }

  function apply(state: KeepAwakeState): void {
    if (stopped) {
      return;
    }
    lastState = state;
    const args = buildCaffeinateArgs({ ...state, appPid: deps.appPid });
    if (child && sameArgs(childArgs, args)) {
      return;
    }
    if (child) {
      deps.log.info("[keep-awake] caffeinate stopping", { pid: child.pid ?? null });
      killChild();
    }
    if (args) {
      spawnChild(args);
    }
  }

  return {
    apply,
    stop() {
      stopped = true;
      killChild();
    },
  };
}

function sameArgs(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
