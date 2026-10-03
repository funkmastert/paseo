import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface WriteFileAtomicOptions {
  /** Applied to the temp file at creation and again with `chmod` before the rename, umask-proof. */
  mode?: number;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, { encoding: "utf8", mode: options?.mode });
    if (options?.mode !== undefined) await fs.chmod(tempPath, options.mode);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), options);
}
