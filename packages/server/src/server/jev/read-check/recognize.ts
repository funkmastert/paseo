import path from "node:path";

import {
  commandName,
  resolvePath,
  walkShellCommands,
  type ExpandedWord,
} from "../../agent/shell-commands.js";

/**
 * Which tool calls load a file into an agent's context (docs/jev.md, "What counts as a read"):
 * a Claude `Read`, or a Bash command line that only reads files. Pure: nothing here touches the
 * file system.
 */

/** The part of a file a reader prints. Lines are 1-based and inclusive; `last: null` is the end. */
export type FileReadRange =
  | { kind: "all" }
  | { kind: "lines"; first: number; last: number | null }
  | { kind: "last-lines"; count: number }
  | { kind: "first-bytes"; count: number }
  | { kind: "last-bytes"; count: number };

export interface RecognizedFile {
  /** Absolute, as the command spelled it; the observer resolves symlinks. */
  path: string;
  range: FileReadRange;
}

export interface RecognizedRead {
  tool: "Read" | "Bash";
  files: RecognizedFile[];
  /**
   * Ranges applied by readers with no file operand to what the earlier ones printed:
   * `cat big.log | head -100`. Applied in order to the concatenated output.
   */
  filters: FileReadRange[];
  /** An image, a PDF page range or a notebook: counted as `not-text`, never judged. */
  notText: boolean;
  /** The Bash call's `description`, when it has one. */
  why: string | null;
}

export interface RecognizeReadInput {
  toolName: string;
  toolInput: unknown;
  /** Where relative paths resolve: the hook's cwd, which the Bash tool keeps between calls. */
  cwd: string;
  home: string | null;
}

/** The `Read` tool's own default page when no `limit` is given. */
export const READ_TOOL_DEFAULT_LIMIT = 2000;

const NOT_TEXT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".heic",
  ".tif",
  ".tiff",
  ".pdf",
  ".ipynb",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function recognizeReadTool(input: RecognizeReadInput): RecognizedRead | null {
  const toolInput = record(input.toolInput);
  const filePath = toolInput?.["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(input.cwd, filePath);
  const notText =
    toolInput?.["pages"] !== undefined ||
    NOT_TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase());
  const first = positiveInteger(toolInput?.["offset"]) ?? 1;
  const limit = positiveInteger(toolInput?.["limit"]) ?? READ_TOOL_DEFAULT_LIMIT;
  return {
    tool: "Read",
    files: [{ path: absolute, range: { kind: "lines", first, last: first + limit - 1 } }],
    filters: [],
    notText,
    why: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Readers. Each parses its own options and answers the range it prints and the words that name
// files, or null when this use of it is not a plain read (`sed -i`, `tail -f`, `less -o log`).
// ---------------------------------------------------------------------------------------------

interface ReaderParse {
  range: FileReadRange;
  operands: ExpandedWord[];
}

type ReaderParser = (args: ExpandedWord[]) => ReaderParse | null;

function count(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  return Number(text);
}

/** `--name=value` or `--name value`; returns the value and how many words it took. */
function longValue(
  args: ExpandedWord[],
  index: number,
  name: string,
): { value: string; width: number } | null {
  const text = args[index]?.text ?? "";
  if (text.startsWith(`${name}=`)) return { value: text.slice(name.length + 1), width: 1 };
  if (text === name) {
    const next = args[index + 1];
    return next?.resolved ? { value: next.text, width: 2 } : null;
  }
  return null;
}

/**
 * Options are skipped, those in `withValue` with the word after them (or attached: `-x4`), and
 * everything else is an operand. `--` ends the options. A `-` operand is stdin.
 */
function splitOptions(
  args: ExpandedWord[],
  withValue: ReadonlySet<string>,
  refuse: ReadonlySet<string>,
): ExpandedWord[] | null {
  const operands: ExpandedWord[] = [];
  let index = 0;
  let optionsDone = false;
  while (index < args.length) {
    const arg = args[index]!;
    const text = arg.text;
    if (optionsDone || !arg.resolved || !text.startsWith("-") || text === "-") {
      operands.push(arg);
      index += 1;
      continue;
    }
    if (text === "--") {
      optionsDone = true;
      index += 1;
      continue;
    }
    const name = text.startsWith("--") ? text.split("=")[0]! : text.slice(0, 2);
    if (refuse.has(name)) return null;
    if (withValue.has(name)) {
      const attached = text.startsWith("--") ? text.includes("=") : text.length > 2;
      index += attached ? 1 : 2;
      continue;
    }
    index += 1;
  }
  return operands;
}

const parseCat: ReaderParser = (args) => {
  const operands = splitOptions(args, new Set(), new Set());
  return operands ? { range: { kind: "all" }, operands } : null;
};

function parseHeadTail(args: ExpandedWord[], which: "head" | "tail"): ReaderParse | null {
  let lines: number | null = 10;
  let bytes: number | null = null;
  let fromLine: number | null = null;
  const operands: ExpandedWord[] = [];
  let optionsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const text = arg.text;
    if (optionsDone || !arg.resolved || text === "-" || !/^[-+]/.test(text)) {
      operands.push(arg);
      continue;
    }
    if (text === "--") {
      optionsDone = true;
      continue;
    }
    if (which === "tail" && /^(-[fF]|--follow|--retry|--pid|-s|--sleep-interval)/.test(text)) {
      return null;
    }
    const linesValue = longValue(args, index, "--lines");
    const bytesValue = longValue(args, index, "--bytes");
    let value: string | undefined;
    let unit: "lines" | "bytes" | null = null;
    if (linesValue) {
      value = linesValue.value;
      unit = "lines";
      index += linesValue.width - 1;
    } else if (bytesValue) {
      value = bytesValue.value;
      unit = "bytes";
      index += bytesValue.width - 1;
    } else if (/^-[nc]$/.test(text)) {
      value = args[index + 1]?.text;
      unit = text === "-n" ? "lines" : "bytes";
      index += 1;
    } else if (/^-[nc]./.test(text)) {
      value = text.slice(2);
      unit = text[1] === "n" ? "lines" : "bytes";
    } else if (/^-\d+$/.test(text)) {
      value = text.slice(1);
      unit = "lines";
    } else if (which === "tail" && /^\+\d+$/.test(text)) {
      value = text;
      unit = "lines";
    } else {
      // -q, -v, -r, --quiet, --verbose: print nothing extra worth counting.
      continue;
    }
    if (value === undefined) return null;
    if (which === "tail" && value.startsWith("+")) {
      const from = count(value.slice(1));
      if (from === null) return null;
      if (unit === "bytes") return { range: { kind: "all" }, operands: [] };
      fromLine = Math.max(1, from);
      lines = null;
      bytes = null;
      continue;
    }
    const amount = count(value);
    // GNU `head -n -5` (all but the last 5) and anything unparsed print up to the whole file.
    if (amount === null) {
      lines = null;
      bytes = null;
      fromLine = null;
      continue;
    }
    if (unit === "lines") {
      lines = amount;
      bytes = null;
    } else {
      bytes = amount;
      lines = null;
    }
    fromLine = null;
  }
  let range: FileReadRange;
  if (fromLine !== null) range = { kind: "lines", first: fromLine, last: null };
  else if (bytes !== null)
    range =
      which === "head"
        ? { kind: "first-bytes", count: bytes }
        : { kind: "last-bytes", count: bytes };
  else if (lines !== null)
    range =
      which === "head"
        ? { kind: "lines", first: 1, last: lines }
        : { kind: "last-lines", count: lines };
  else range = { kind: "all" };
  return { range, operands };
}

/**
 * A `sed -n` script that only prints: addresses (`12`, `12,40`, `$`, `/re/`) and `p`, `P`, `=`,
 * `l`, `q`, `n`, `N`, braces and `;`. Anything that writes (`w`, `s///w`), runs (`e`) or
 * transforms is not a plain read.
 */
function sedPrintRange(script: string): FileReadRange | null {
  const withoutRegexes = script.replace(/\/(?:\\.|[^/\\])*\//g, "R");
  if (!/^[\d\s,;$!{}pPlqnN=R~+]*$/.test(withoutRegexes)) return null;
  if (!/[pPl=]/.test(withoutRegexes)) return null;
  const commands = withoutRegexes
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  let first = Number.POSITIVE_INFINITY;
  let last: number | null = 0;
  for (const command of commands) {
    const match = /^(\d+|\$|R)?(?:\s*,\s*(\d+|\$|R|\+\d+))?\s*!?\s*[{}pPlqnN=\s]*$/.exec(command);
    if (!match) return null;
    const [, start, end] = match;
    if (start === undefined || start === "R" || end === "R") return { kind: "all" };
    if (start === "$") {
      // `$p`: the last line only.
      if (commands.length === 1) return { kind: "last-lines", count: 1 };
      return { kind: "all" };
    }
    const startLine = Number(start);
    first = Math.min(first, startLine);
    if (end === undefined) {
      if (last !== null) last = Math.max(last, startLine);
    } else if (end === "$") {
      last = null;
    } else if (end.startsWith("+")) {
      if (last !== null) last = Math.max(last, startLine + Number(end.slice(1)));
    } else if (last !== null) {
      last = Math.max(last, Number(end));
    }
  }
  if (!Number.isFinite(first)) return { kind: "all" };
  return { kind: "lines", first: Math.max(1, first), last };
}

const SED_HARMLESS_LONG = new Set([
  "--regexp-extended",
  "--posix",
  "--debug",
  "--separate",
  "--unbuffered",
  "--null-data",
  "--sandbox",
]);

const parseSed: ReaderParser = (args) => {
  let quiet = false;
  const scripts: string[] = [];
  const operands: ExpandedWord[] = [];
  let optionsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const text = arg.text;
    if (optionsDone || !arg.resolved || text === "-" || !text.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (text === "--") {
      optionsDone = true;
    } else if (text === "--quiet" || text === "--silent") {
      quiet = true;
    } else if (text === "--expression" || text.startsWith("--expression=")) {
      const value = longValue(args, index, "--expression");
      if (!value) return null;
      scripts.push(value.value);
      index += value.width - 1;
    } else if (text === "--line-length") {
      index += 1;
    } else if (text.startsWith("--")) {
      // `--in-place` and `--file` write a file or run a script we cannot see.
      if (!SED_HARMLESS_LONG.has(text.split("=")[0]!)) return null;
    } else {
      // A short cluster: `-n`, `-nE`, `-ne SCRIPT`, `-n -e SCRIPT`.
      for (let letter = 1; letter < text.length; letter += 1) {
        const flag = text[letter]!;
        if (flag === "n") {
          quiet = true;
        } else if ("Erszu".includes(flag)) {
          continue;
        } else if (flag === "e" || flag === "l") {
          const rest = text.slice(letter + 1);
          const value = rest || (args[index + 1]?.resolved ? args[index + 1]!.text : undefined);
          if (value === undefined) return null;
          if (!rest) index += 1;
          if (flag === "e") scripts.push(value);
          break;
        } else {
          // `-i` edits in place, `-f` reads a script file: not a plain read.
          return null;
        }
      }
    }
  }
  if (!quiet) return null;
  if (scripts.length === 0) {
    const script = operands.shift();
    if (!script?.resolved) return null;
    scripts.push(script.text);
  }
  let range: FileReadRange | null = null;
  for (const script of scripts) {
    const next = sedPrintRange(script);
    if (!next) return null;
    range = range === null ? next : { kind: "all" };
  }
  return range ? { range, operands } : null;
};

const LESS_WITH_VALUE = new Set([
  "-b",
  "-h",
  "-j",
  "-k",
  "-p",
  "-P",
  "-t",
  "-T",
  "-x",
  "-y",
  "-z",
  "-#",
  "--buffers",
  "--max-back-scroll",
  "--jump-target",
  "--lesskey-file",
  "--pattern",
  "--prompt",
  "--tag",
  "--tag-file",
  "--tabs",
  "--max-forw-scroll",
  "--window",
  "--shift",
]);
const LESS_REFUSE = new Set(["-o", "-O", "--log-file", "--LOG-FILE"]);

const parseLess: ReaderParser = (args) => {
  // `+cmd` is a startup command, not a file.
  const operands = splitOptions(
    args.filter((arg) => !(arg.resolved && arg.text.startsWith("+"))),
    LESS_WITH_VALUE,
    LESS_REFUSE,
  );
  return operands ? { range: { kind: "all" }, operands } : null;
};

const BAT_WITH_VALUE = new Set([
  "-l",
  "--language",
  "-H",
  "--highlight-line",
  "-r",
  "--line-range",
  "--style",
  "--theme",
  "--tabs",
  "--wrap",
  "--terminal-width",
  "-m",
  "--map-syntax",
  "--color",
  "--italic-text",
  "--decorations",
  "--paging",
  "--pager",
  "--file-name",
  "--diff-context",
  "--nonprintable-notation",
  "--binary",
  "--squeeze-limit",
  "--ignored-suffix",
]);
const BAT_REFUSE = new Set([
  "--list-themes",
  "--list-languages",
  "--config-file",
  "--generate-config-file",
  "--config-dir",
  "--cache-dir",
  "--diagnostic",
  "--acknowledgements",
]);

/** `--line-range 30:40`, `30:`, `:40`; several ranges print up to the whole file. */
function batRange(args: ExpandedWord[]): FileReadRange {
  const ranges: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const long = longValue(args, index, "--line-range");
    if (long) {
      ranges.push(long.value);
      continue;
    }
    if (args[index]?.text === "-r" && args[index + 1]?.resolved) ranges.push(args[index + 1]!.text);
    else if (/^-r.+/.test(args[index]?.text ?? "")) ranges.push(args[index]!.text.slice(2));
  }
  if (ranges.length !== 1) return { kind: "all" };
  const match = /^(\d*):(\d*)$/.exec(ranges[0]!);
  if (!match) return { kind: "all" };
  const first = match[1] ? Number(match[1]) : 1;
  const last = match[2] ? Number(match[2]) : null;
  return { kind: "lines", first: Math.max(1, first), last };
}

const parseBat: ReaderParser = (args) => {
  const operands = splitOptions(args, BAT_WITH_VALUE, BAT_REFUSE);
  return operands ? { range: batRange(args), operands } : null;
};

const NL_WITH_VALUE = new Set([
  "-b",
  "-d",
  "-f",
  "-h",
  "-i",
  "-l",
  "-n",
  "-s",
  "-v",
  "-w",
  "--body-numbering",
  "--section-delimiter",
  "--footer-numbering",
  "--header-numbering",
  "--line-increment",
  "--join-blank-lines",
  "--number-format",
  "--number-separator",
  "--starting-line-number",
  "--number-width",
]);

const parseNl: ReaderParser = (args) => {
  const operands = splitOptions(args, NL_WITH_VALUE, new Set());
  return operands ? { range: { kind: "all" }, operands } : null;
};

const READERS: Record<string, ReaderParser> = {
  cat: parseCat,
  head: (args) => parseHeadTail(args, "head"),
  tail: (args) => parseHeadTail(args, "tail"),
  sed: parseSed,
  less: parseLess,
  more: parseLess,
  bat: parseBat,
  batcat: parseBat,
  nl: parseNl,
};

/** Output redirections that write no file: `2>/dev/null`. Descriptor dups never reach the visitor. */
function isHarmlessRedirect(target: ExpandedWord): boolean {
  return target.resolved && target.text === "/dev/null";
}

/** A word the shell would expand into other names: `src/*.ts`, `a.{ts,js}`, `file?.txt`. */
function isPattern(word: ExpandedWord): boolean {
  return word.globsDirectory || /[*?]/.test(word.text) || /\{[^}]*,[^}]*\}/.test(word.text);
}

function recognizeBash(input: RecognizeReadInput): RecognizedRead | null {
  const toolInput = record(input.toolInput);
  const command = toolInput?.["command"];
  if (typeof command !== "string" || command.trim().length === 0) return null;
  // A background command is not a read the agent waits on.
  if (toolInput?.["run_in_background"] === true) return null;
  const description = toolInput?.["description"];

  const files: RecognizedFile[] = [];
  const filters: FileReadRange[] = [];
  let plain = true;
  walkShellCommands(
    command,
    { cwd: input.cwd, home: input.home },
    {
      command(args, context) {
        const reader = READERS[commandName(args[0]!.text)];
        const parsed = reader?.(args.slice(1));
        if (!parsed || parsed.operands.some((word) => !word.resolved || isPattern(word))) {
          plain = false;
          return true;
        }
        const named = parsed.operands.filter((word) => word.text !== "-");
        if (named.length === 0) {
          filters.push(parsed.range);
          return false;
        }
        for (const word of named) {
          const resolved = resolvePath(context.cwd, word.text);
          if (resolved === null) {
            plain = false;
            return true;
          }
          files.push({ path: resolved, range: parsed.range });
        }
        return false;
      },
      outputRedirect(target) {
        if (isHarmlessRedirect(target)) return false;
        plain = false;
        return true;
      },
      unresolvedCommand() {
        plain = false;
        return true;
      },
    },
  );
  if (!plain || files.length === 0) return null;
  return {
    tool: "Bash",
    files,
    filters: filters.filter((range) => range.kind !== "all"),
    notText: false,
    why: typeof description === "string" && description.trim() ? description.trim() : null,
  };
}

/** The read a tool call makes, or null when it is not a file read. Never throws on odd input. */
export function recognizeRead(input: RecognizeReadInput): RecognizedRead | null {
  if (input.toolName === "Read") return recognizeReadTool(input);
  if (input.toolName === "Bash") return recognizeBash(input);
  return null;
}

/** A stable key for a range, for the repeat check. */
export function rangeKey(range: FileReadRange): string {
  switch (range.kind) {
    case "all":
      return "all";
    case "lines":
      return `lines:${range.first}-${range.last ?? "end"}`;
    case "last-lines":
      return `last-lines:${range.count}`;
    case "first-bytes":
      return `first-bytes:${range.count}`;
    case "last-bytes":
      return `last-bytes:${range.count}`;
  }
}

/** The tools whose calls change a file, for the validation window and live mode's edit rule. */
export const READ_CHECK_EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/** The path an edit tool call changes, or null. */
export function editedPath(input: RecognizeReadInput): string | null {
  if (!(READ_CHECK_EDIT_TOOLS as readonly string[]).includes(input.toolName)) return null;
  const toolInput = record(input.toolInput);
  const filePath = toolInput?.["file_path"] ?? toolInput?.["notebook_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(input.cwd, filePath);
}
