import { statfs } from "node:fs/promises";

/**
 * Free bytes on the volume that holds `target`, or null when it can't be read. The one place shared
 * builds read free disk, so the disk brake's shared read can replace it without touching callers.
 */
export async function readFreeDiskBytes(target: string): Promise<number | null> {
  try {
    const stats = await statfs(target);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
