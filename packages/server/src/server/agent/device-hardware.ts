/**
 * Reads the hardware facts device-slot-defaults.ts divides by. Sampled once — a machine does not
 * grow cores — and injectable so tests derive caps for machines nobody has.
 */

import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { promisify } from "node:util";
import type { SystemHardware } from "./device-slot-defaults.js";

const execFileAsync = promisify(execFile);
const SYSCTL_TIMEOUT_MS = 5_000;

export type HardwareReader = () => Promise<SystemHardware>;

function fallbackHardware(): SystemHardware {
  return { memoryBytes: totalmem(), cpuCount: cpus().length };
}

export const readSystemHardware: HardwareReader = async () => {
  const hardware = fallbackHardware();
  if (process.platform !== "darwin") return hardware;
  try {
    // Asked on its own because `sysctl` exits non-zero on an unknown key: an Intel Mac has no
    // perflevel keys, and bundling this with hw.memsize would throw away the whole reading.
    const { stdout } = await execFileAsync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], {
      timeout: SYSCTL_TIMEOUT_MS,
    });
    const performanceCpuCount = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(performanceCpuCount) && performanceCpuCount > 0
      ? { ...hardware, performanceCpuCount }
      : hardware;
  } catch {
    // No performance-core split to be had. node's hw.memsize/hw.ncpu view still stands.
    return hardware;
  }
};
