import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * Appends JSON lines to one file, off the caller's path, in order. The file is 0600 and rotates
 * once to `<file>.1` past `maxBytes`. For measurement records that must outlive `daemon.log`,
 * which the supervisor keeps at 10 MB x 3 files, a few hours on a busy fleet.
 */
export interface JsonlAppender {
  /** Enqueues the line. Never throws. */
  append(line: object): void;
  /** Resolves once every line enqueued so far is written or has failed. */
  flush(): Promise<void>;
}

export function createJsonlAppender(options: {
  filePath: string;
  maxBytes: number;
  logger: Logger;
  platform?: NodeJS.Platform;
}): JsonlAppender {
  const { filePath, maxBytes, logger } = options;
  const isWindows = (options.platform ?? process.platform) === "win32";
  let chain: Promise<void> = Promise.resolve();
  let size: number | null = null;

  async function write(line: object): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (size === null) {
      await fs.mkdir(
        path.dirname(filePath),
        isWindows ? { recursive: true } : { recursive: true, mode: 0o700 },
      );
      size = (await fs.stat(filePath).catch(() => null))?.size ?? 0;
    }
    if (size + bytes > maxBytes) {
      await fs.rename(filePath, `${filePath}.1`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      size = 0;
    }
    await fs.appendFile(filePath, text, isWindows ? {} : { mode: 0o600 });
    size += bytes;
  }

  return {
    append(line) {
      chain = chain.then(() =>
        write(line).catch((error: unknown) => {
          // A failed stat or rotation leaves the size unknown; read it again next time.
          size = null;
          logger.warn({ err: error, filePath }, "jsonl append failed");
        }),
      );
    },
    flush: () => chain,
  };
}
