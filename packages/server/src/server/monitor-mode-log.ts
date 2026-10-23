/**
 * The "is it running?" line for the daemon's monitors. Each monitor reports the mode it resolved
 * from its own config read — not the config file — at start and whenever that mode changes, so
 * `grep '"msg":"Monitor mode"' daemon.log` answers what every monitor is doing and when that
 * last changed. A mode the file asked for but the monitor never saw shows up here as the wrong
 * value instead of as silence.
 */

export interface MonitorMode {
  monitor: string;
  enabled: boolean;
  /** Only for the legs that act on something; they all have a dry run. */
  dryRun?: boolean;
}

interface MonitorModeLogger {
  info: (obj: object, msg?: string) => void;
}

export class MonitorModeLog {
  private readonly logger: MonitorModeLogger;
  private readonly lastLogged = new Map<string, string>();

  constructor(logger: MonitorModeLogger) {
    this.logger = logger;
  }

  report(modes: readonly MonitorMode[]): void {
    for (const mode of modes) {
      const key = JSON.stringify(mode);
      if (this.lastLogged.get(mode.monitor) === key) continue;
      this.lastLogged.set(mode.monitor, key);
      this.logger.info(mode, "Monitor mode");
    }
  }
}
