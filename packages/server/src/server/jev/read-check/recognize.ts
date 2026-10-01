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

interface CountSetting {
  unit: "lines" | "bytes";
  /** Null prints up to the whole file: GNU `head -n -5` and anything unparsed. */
  amount: number | null;
  /** `tail -n +N`: from line N to the end. */
  fromStart: boolean;
}

/** A `-n`/`-c`/`--lines`/`--bytes`/`-N`/`+N` option at `index`, or null for any other flag. */
function countOption(
  args: ExpandedWord[],
  index: number,
  which: "head" | "tail",
): { unit: "lines" | "bytes"; value: string | undefined; width: number } | null {
  const text = args[index]!.text;
  const lines = longValue(args, index, "--lines");
  if (lines) return { unit: "lines", value: lines.value, width: lines.width };
  const bytes = longValue(args, index, "--bytes");
  if (bytes) return { unit: "bytes", value: bytes.value, width: bytes.width };
  const unit = text[1] === "c" ? "bytes" : "lines";
  if (/^-[nc]$/.test(text)) return { unit, value: args[index + 1]?.text, width: 2 };
  if (/^-[nc]./.test(text)) return { unit, value: text.slice(2), width: 1 };
  if (/^-\d+$/.test(text)) return { unit: "lines", value: text.slice(1), width: 1 };
  if (which === "tail" && /^\+\d+$/.test(text)) return { unit: "lines", value: text, width: 1 };
  return null;
}

function countSetting(
  unit: "lines" | "bytes",
  value: string,
  which: "head" | "tail",
): CountSetting | null {
  if (which === "tail" && value.startsWith("+")) {
    const from = count(value.slice(1));
    return from === null ? null : { unit, amount: from, fromStart: true };
  }
  return { unit, amount: count(value), fromStart: false };
}

function countRange(setting: CountSetting, which: "head" | "tail"): FileReadRange {
  const { unit, amount } = setting;
  if (amount === null) return { kind: "all" };
  if (setting.fromStart) {
    return unit === "lines"
      ? { kind: "lines", first: Math.max(1, amount), last: null }
      : { kind: "all" };
  }
  if (which === "head") {
    return unit === "lines"
      ? { kind: "lines", first: 1, last: amount }
      : { kind: "first-bytes", count: amount };
  }
  return unit === "lines"
    ? { kind: "last-lines", count: amount }
    : { kind: "last-bytes", count: amount };
}

const TAIL_FOLLOW_RE = /^(-[fF]|--follow|--retry|--pid|-s|--sleep-interval)/;

function parseHeadTail(args: ExpandedWord[], which: "head" | "tail"): ReaderParse | null {
  let setting: CountSetting = { unit: "lines", amount: 10, fromStart: false };
  const operands: ExpandedWord[] = [];
  let optionsDone = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsDone || !arg.resolved || arg.text === "-" || !/^[-+]/.test(arg.text)) {
      operands.push(arg);
      continue;
    }
    if (arg.text === "--") {
      optionsDone = true;
      continue;
    }
    // `tail -f` never ends: not a read the agent waits on.
    if (which === "tail" && TAIL_FOLLOW_RE.test(arg.text)) return null;
    // -q, -v, -r, --quiet, --verbose: print nothing extra worth counting.
    const option = countOption(args, index, which);
    if (!option) continue;
    if (option.value === undefined) return null;
    index += option.width - 1;
    const next = countSetting(option.unit, option.value, which);
    if (!next) return null;
    setting = next;
  }
  return { range: countRange(setting, which), operands };
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

interface SedOptions {
  quiet: boolean;
  scripts: string[];
  operands: ExpandedWord[];
}

/**
 * A short cluster: `-n`, `-nE`, `-ne SCRIPT`, `-n -e SCRIPT`. Returns how many words it took, or
 * null for `-i` (edits in place), `-f` (a script file) and anything unknown.
 */
function readSedCluster(args: ExpandedWord[], index: number, into: SedOptions): number | null {
  const text = args[index]!.text;
  for (let letter = 1; letter < text.length; letter += 1) {
    const flag = text[letter]!;
    if (flag === "n") {
      into.quiet = true;
      continue;
    }
    if ("Erszu".includes(flag)) continue;
    if (flag !== "e" && flag !== "l") return null;
    const rest = text.slice(letter + 1);
    const next = args[index + 1];
    const value = rest || (next?.resolved ? next.text : undefined);
    if (value === undefined) return null;
    if (flag === "e") into.scripts.push(value);
    return rest ? 1 : 2;
  }
  return 1;
}

/** A long option. Returns how many words it took, or null for `--in-place`, `--file` and unknowns. */
function readSedLong(args: ExpandedWord[], index: number, into: SedOptions): number | null {
  const text = args[index]!.text;
  if (text === "--quiet" || text === "--silent") {
    into.quiet = true;
    return 1;
  }
  const expression = longValue(args, index, "--expression");
  if (expression) {
    into.scripts.push(expression.value);
    return expression.width;
  }
  if (text === "--line-length") return 2;
  return SED_HARMLESS_LONG.has(text.split("=")[0]!) ? 1 : null;
}

const parseSed: ReaderParser = (args) => {
  const options: SedOptions = { quiet: false, scripts: [], operands: [] };
  let optionsDone = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index]!;
    if (optionsDone || !arg.resolved || arg.text === "-" || !arg.text.startsWith("-")) {
      options.operands.push(arg);
      index += 1;
      continue;
    }
    if (arg.text === "--") {
      optionsDone = true;
      index += 1;
      continue;
    }
    const width = arg.text.startsWith("--")
      ? readSedLong(args, index, options)
      : readSedCluster(args, index, options);
    if (width === null) return null;
    index += width;
  }
  if (!options.quiet) return null;
  if (options.scripts.length === 0) {
    const script = options.operands.shift();
    if (!script?.resolved) return null;
    options.scripts.push(script.text);
  }
  let range: FileReadRange | null = null;
  for (const script of options.scripts) {
    const next = sedPrintRange(script);
    if (!next) return null;
    range = range === null ? next : { kind: "all" };
  }
  return range ? { range, operands: options.operands } : null;
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
