import { promises as fs } from "node:fs";
import type { Logger } from "pino";

// Reads an append-only JSONL file. A crash mid-append can leave a partial last line; it is cut off
// here before anything appends after it. A bad line anywhere else is corruption and throws.
export async function readJsonlFile<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
  logger: Logger,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw error;
  }
  const lines: T[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf("\n", offset);
    const text = end === -1 ? raw.slice(offset) : raw.slice(offset, end);
    const parsed = parseLine(text, parse);
    if (parsed === null) {
      const isLast = end === -1 || raw.slice(end + 1).trim() === "";
      if (!isLast) throw new Error(`Corrupt JSONL at byte ${offset}: ${filePath}`);
      logger.warn({ filePath }, "Dropping a torn last JSONL line");
      await fs.truncate(filePath, Buffer.byteLength(raw.slice(0, offset)));
      break;
    }
    lines.push(parsed);
    if (end === -1) {
      // A complete last line without its newline: add one so the next append starts clean.
      await fs.appendFile(filePath, "\n");
      break;
    }
    offset = end + 1;
  }
  return lines;
}

function parseLine<T>(text: string, parse: (value: unknown) => T | null): T | null {
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}
