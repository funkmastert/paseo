import { spawn } from "node:child_process";
import { app, powerMonitor } from "electron";
import log from "electron-log/main";

import type { DesktopSettings, DesktopSettingsStore } from "../settings/desktop-settings.js";
import { createKeepAwakeController } from "./keep-awake.js";

const CAFFEINATE_PATH = "/usr/bin/caffeinate";

// macOS only. The caffeinate child watches the app pid, not the daemon, so a
// daemon restart leaves it running and an app exit of any kind ends it.
export function startKeepAwake({ settingsStore }: { settingsStore: DesktopSettingsStore }): void {
  const controller = createKeepAwakeController({
    appPid: process.pid,
    spawn: (args) => spawn(CAFFEINATE_PATH, args, { stdio: "ignore" }),
    log: {
      info: (message, details) => log.info(message, details ?? {}),
      warn: (message, details) => log.warn(message, details ?? {}),
    },
  });

  let settings: DesktopSettings["power"] | null = null;
  const apply = () => {
    if (settings) {
      controller.apply({ settings, onBatteryPower: powerMonitor.isOnBatteryPower() });
    }
  };

  settingsStore.subscribe((next) => {
    settings = next.power;
    apply();
  });
  powerMonitor.on("on-ac", apply);
  powerMonitor.on("on-battery", apply);
  app.on("will-quit", () => controller.stop());

  void (async () => {
    try {
      const loaded = await settingsStore.get();
      settings ??= loaded.power;
      apply();
    } catch (error) {
      log.error("[keep-awake] failed to load desktop settings", error);
    }
  })();
}
