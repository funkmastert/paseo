import { execCommand } from "./spawn.js";

export interface SampleDirectorySizeOptions {
  timeoutMs: number;
}

/**
 * Best-effort `du -sk` sample of a directory's total size, in bytes. Returns `undefined` on any
 * failure — a nonzero exit, a timeout, or output that doesn't parse as a leading non-negative
 * integer — never `0`. worktree-disk-monitor.ts treats `undefined` as "still unknown"; conflating
 * a sampling hiccup with a genuinely empty directory would make the disk-usage indicator lie.
 */
export async function sampleDirectorySizeBytes(
  path: string,
  options: SampleDirectorySizeOptions,
): Promise<number | undefined> {
  try {
    const { stdout } = await execCommand("du", ["-sk", path], {
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    // `du -sk` prints "<kilobytes>\t<path>"; only the leading field is ours.
    const firstField = stdout.trim().split(/\s+/, 1)[0];
    if (firstField === undefined || firstField.length === 0) {
      return undefined;
    }
    if (!/^\d+$/.test(firstField)) {
      return undefined;
    }
    const kilobytes = Number.parseInt(firstField, 10);
    if (!Number.isFinite(kilobytes)) {
      return undefined;
    }
    return kilobytes * 1024;
  } catch {
    return undefined;
  }
}
