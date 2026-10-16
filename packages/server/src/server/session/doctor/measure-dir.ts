import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Bytes under a directory, or null when the deadline (epoch ms) passes first. Uses `du` where it
 * exists (fast on APFS/ext4, and it does not follow symlinks); Windows walks the tree itself.
 */
export async function measureDirBytes(target: string, deadline: number): Promise<number | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  if (process.platform === "win32") return walkBytes(target, deadline);
  return new Promise((resolve) => {
    execFile("du", ["-sk", target], { timeout: remaining, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const kb = Number.parseInt(stdout.split(/\s/)[0] ?? "", 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

async function walkBytes(root: string, deadline: number): Promise<number | null> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) return null;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += (await fs.lstat(full)).size;
        } catch {
          // Vanished while walking.
        }
      }
    }
  }
  return total;
}
