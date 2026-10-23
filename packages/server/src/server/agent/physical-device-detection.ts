/**
 * Turns physical-device detection (`adb track-devices`, the devicectl poll) on and off with the
 * `agents.deviceLeases.enabled` switch. While device management is off nothing is spawned: no
 * adb child (which would also start the adb server), no devicectl every 15 s — on the live
 * daemon, on every scratch and e2e daemon, and in tests. docs/device-leases.md, Physical devices.
 */

interface DetectionSource {
  start(): void;
  stop(): void;
}

export interface PhysicalDeviceDetectionOptions {
  adb: DetectionSource & { sweepOrphan(): Promise<void> };
  devicectl: DetectionSource;
  isEnabled: () => boolean;
  /** Detection stopped: whatever it last reported is no longer known. */
  onStopped: () => void;
  logger: { warn: (obj: object, msg?: string) => void };
}

export class PhysicalDeviceDetection {
  private readonly options: PhysicalDeviceDetectionOptions;
  private armed = false;

  constructor(options: PhysicalDeviceDetectionOptions) {
    this.options = options;
  }

  /** Once the daemon is listening: sweep a crashed daemon's leftover adb child, then follow the
   * switch. Before this, `sync()` does nothing, so a bootstrap that fails leaves no child. */
  async start(): Promise<void> {
    await this.options.adb.sweepOrphan().catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "Sweeping a leftover adb track-devices failed");
    });
    this.armed = true;
    this.sync();
  }

  /** Re-reads the switch. Call on every daemon config change. */
  sync(): void {
    if (!this.armed) return;
    if (this.options.isEnabled()) {
      this.options.adb.start();
      this.options.devicectl.start();
      return;
    }
    this.halt();
  }

  stop(): void {
    this.armed = false;
    this.halt();
  }

  private halt(): void {
    this.options.adb.stop();
    this.options.devicectl.stop();
    this.options.onStopped();
  }
}
