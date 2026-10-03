/**
 * Which processes have anything open inside a directory — their cwd, their executable, a file —
 * read from one `lsof` over every process the daemon's user can see. The daemon knows the cwds of
 * the agents it started; this sees the rest: a Claude session started outside Paseo, a shell
 * someone `cd`ed into, a dev server, an editor's language server. The done janitor keeps any
 * worktree this finds a process in (docs/done-janitor.md, "The deletion invariant").
 *
 * Read-only. A scan that fails is `failed`, never an empty list: not knowing is a reason to keep.
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Every process's open files runs to tens of thousands of lines; a truncated scan is a failed one. */
const LSOF_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const LSOF_TIMEOUT_MS = 60_000;

export interface ProcessInside {
  pid: number;
  command: string;
  /** The first path lsof reported for it inside the directory. */
  path: string;
}

export type ProcessScan =
  | { kind: "scanned"; processes: ProcessInside[] }
  | { kind: "failed"; error: string };

export interface ListProcessesInsideOptions {
  /** `lsof -F pcn` output; a seam for tests. */
  runLsof?: () => Promise<string>;
  /** Left out: the daemon's own watchers and logs, which archive-by-scope tears down itself. */
  selfPid?: number;
  platform?: NodeJS.Platform;
}

export async function listProcessesInside(
  directory: string,
  options: ListProcessesInsideOptions = {},
): Promise<ProcessScan> {
  if ((options.platform ?? process.platform) === "win32") {
    return { kind: "failed", error: "lsof is not available on Windows" };
  }
  let output: string;
  try {
    output = await (options.runLsof ?? runLsof)();
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (!output.startsWith("p")) return { kind: "failed", error: "lsof listed no processes" };
  const roots = directoryForms(directory);
  const selfPid = options.selfPid ?? process.pid;
  const byPid = new Map<number, ProcessInside>();
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number.parseInt(value, 10);
      command = "";
    } else if (field === "c") {
      command = value;
    } else if (field === "n" && pid !== selfPid && !byPid.has(pid) && isInside(value, roots)) {
      byPid.set(pid, { pid, command, path: value });
    }
  }
  return { kind: "scanned", processes: [...byPid.values()] };
}

/** The directory as given and as resolved: lsof reports the real path, a cwd may be either. */
function directoryForms(directory: string): string[] {
  const forms = new Set([resolve(directory)]);
  try {
    forms.add(realpathSync(directory));
  } catch {
    // Gone: its given form is all there is to match.
  }
  return [...forms];
}

function isInside(path: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep),
  );
}

function runLsof(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "lsof",
      ["-n", "-P", "-w", "-F", "pcn"],
      { maxBuffer: LSOF_MAX_BUFFER_BYTES, timeout: LSOF_TIMEOUT_MS, encoding: "utf8" },
      // Any error fails the scan, a non-zero exit included: lsof exits 1 when there was a
      // process it could not read, and that process may be the one inside.
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}
