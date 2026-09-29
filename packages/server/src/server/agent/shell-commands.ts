import path from "node:path";

/**
 * Just enough of a POSIX shell to say which commands a command line runs: words, quotes,
 * operators, redirections, heredocs, subshells, `$(…)` and backticks, `bash -c`, `eval`, and
 * wrappers such as `sudo`, `env` and `xargs`. It tracks `cd` and plain assignments within the
 * line, so `cd / && rm -rf *` resolves. It never runs anything, and what it cannot resolve (an
 * unknown variable, a command's output) it reports as unresolved rather than guessing.
 *
 * Used by the catastrophe gate (catastrophe-gate.ts); deliberately knows nothing of its rules.
 */

/** Where a command runs, as far as the walk can tell. */
export interface ShellContext {
  /** Null once a `cd` goes somewhere unresolvable; relative paths are then unknown too. */
  readonly cwd: string | null;
  readonly home: string | null;
  /**
   * Git Bash on Windows: `\` also separates, `C:\x` and `C:/x` are `/c/x`, and `$USERPROFILE`
   * is the home directory. `cwd` and `home` are already in the `/c/x` form.
   */
  readonly windowsPaths?: boolean;
}

export interface ShellVisitor {
  /**
   * A command about to run, with wrappers (`sudo`, `env`, `xargs`, …) peeled so `args[0]` is
   * the program. Returning true stops the walk.
   */
  command(args: ExpandedWord[], context: ShellContext): boolean;
  /** The file an output redirection (`>`, `>>`, `&>`, …) writes. Returning true stops the walk. */
  outputRedirect(target: ExpandedWord, context: ShellContext): boolean;
}

/** Visits every command `script` would run, in order, including nested and substituted ones. */
export function walkShellCommands(
  script: string,
  context: ShellContext,
  visitor: ShellVisitor,
): void {
  evalScript(script, { ...context, vars: new Map() }, { visitor, stopped: false }, 0);
}

/** Whether a line typed into a shell leaves it waiting for more: an open heredoc or quote. */
export function isIncompleteShellInput(script: string): boolean {
  return new ShellTokenizer(script).tokenize().incomplete;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer: POSIX-shell words, operators, redirections and heredocs. Expansion is deferred to
// evaluation, because `cd` and assignments earlier in the same line change what a word means.
// ---------------------------------------------------------------------------------------------

type WordPart =
  | { kind: "text"; value: string; quoted: boolean }
  | { kind: "var"; name: string }
  | { kind: "tilde"; user: string }
  | { kind: "substitution"; script: string }
  | { kind: "unknown" };

interface ShellWord {
  parts: WordPart[];
}

interface Heredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  body: string | null;
}

interface Redirect {
  op: string;
  target: ShellWord | null;
  heredoc: Heredoc | null;
}

type ShellToken =
  | { type: "word"; word: ShellWord }
  | { type: "op"; op: string }
  | { type: "redirect"; redirect: Redirect };

interface TokenizeResult {
  tokens: ShellToken[];
  /** An unterminated quote, substitution or heredoc: an interactive shell would wait for more. */
  incomplete: boolean;
}

const CONTROL_OPERATORS = ["&&", "||", ";;", "|&", ";", "&", "|", "(", ")"];
const REDIRECT_OPERATORS = [
  "&>>",
  "<<<",
  "<<-",
  "&>",
  ">>",
  ">|",
  ">&",
  "<&",
  "<>",
  "<<",
  ">",
  "<",
];
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

function isBlank(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isWordBreak(char: string | undefined): boolean {
  return char === undefined || " \t\n;&|()<>".includes(char);
}

function pushText(parts: WordPart[], value: string, quoted: boolean): void {
  const last = parts[parts.length - 1];
  if (last?.kind === "text" && last.quoted === quoted) {
    last.value += value;
  } else {
    parts.push({ kind: "text", value, quoted });
  }
}

function literalText(word: ShellWord): string {
  return word.parts.map((part) => (part.kind === "text" ? part.value : "")).join("");
}

class ShellTokenizer {
  private pos = 0;
  private incomplete = false;
  private readonly tokens: ShellToken[] = [];
  private pendingHeredocs: Heredoc[] = [];

  constructor(private readonly src: string) {}

  tokenize(): TokenizeResult {
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (isBlank(char)) {
        this.pos++;
      } else if (char === "\\" && this.src[this.pos + 1] === "\n") {
        this.pos += 2;
      } else if (char === "\n") {
        this.tokens.push({ type: "op", op: "\n" });
        this.pos++;
        this.readHeredocBodies();
      } else if (char === "#") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
      } else if ((char === "<" || char === ">") && this.src[this.pos + 1] === "(") {
        // Process substitution: the inner command runs; the word it becomes is a path we
        // cannot know.
        this.pos += 2;
        const script = this.readBalancedParens();
        this.tokens.push({ type: "word", word: { parts: [{ kind: "substitution", script }] } });
      } else if (!this.readRedirect() && !this.readControlOperator()) {
        this.readWordToken();
      }
    }
    for (const heredoc of this.pendingHeredocs) {
      heredoc.body ??= "";
      this.incomplete = true;
    }
    return { tokens: this.tokens, incomplete: this.incomplete };
  }

  private readWordToken(): void {
    const word = this.readWord();
    const next = this.src[this.pos];
    // `2>file`: digits right before a redirection are its file descriptor, not a word.
    const isFdNumber =
      (next === "<" || next === ">") &&
      word.parts.length === 1 &&
      word.parts[0]?.kind === "text" &&
      !word.parts[0].quoted &&
      /^\d+$/.test(word.parts[0].value);
    if (!isFdNumber && word.parts.length > 0) this.tokens.push({ type: "word", word });
  }

  private matchAt(candidates: string[]): string | null {
    for (const candidate of candidates) {
      if (this.src.startsWith(candidate, this.pos)) return candidate;
    }
    return null;
  }

  private readControlOperator(): boolean {
    const op = this.matchAt(CONTROL_OPERATORS);
    if (!op) return false;
    this.pos += op.length;
    this.tokens.push({ type: "op", op: op === ";;" ? ";" : op });
    return true;
  }

  private readRedirect(): boolean {
    const op = this.matchAt(REDIRECT_OPERATORS);
    if (!op) return false;
    this.pos += op.length;
    while (isBlank(this.src[this.pos])) this.pos++;
    const target = isWordBreak(this.src[this.pos]) ? null : this.readWord();
    if (op === "<<" || op === "<<-") {
      const heredoc: Heredoc = {
        delimiter: target ? literalText(target) : "",
        quoted: target?.parts.some((part) => part.kind === "text" && part.quoted) ?? false,
        stripTabs: op === "<<-",
        body: null,
      };
      this.pendingHeredocs.push(heredoc);
      this.tokens.push({ type: "redirect", redirect: { op, target: null, heredoc } });
      return true;
    }
    // `>&2` and `<&-` duplicate or close a descriptor; they name no file.
    const duplicatesFd =
      (op === ">&" || op === "<&") && target !== null && /^(\d+|-)$/.test(literalText(target));
    this.tokens.push({
      type: "redirect",
      redirect: { op, target: duplicatesFd ? null : target, heredoc: null },
    });
    return true;
  }

  private readHeredocBodies(): void {
    for (const heredoc of this.pendingHeredocs) {
      const lines: string[] = [];
      let terminated = false;
      while (this.pos < this.src.length) {
        const newline = this.src.indexOf("\n", this.pos);
        const end = newline === -1 ? this.src.length : newline;
        const raw = this.src.slice(this.pos, end);
        const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        this.pos = newline === -1 ? this.src.length : newline + 1;
        if (line === heredoc.delimiter) {
          terminated = true;
          break;
        }
        lines.push(line);
      }
      heredoc.body = lines.join("\n");
      if (!terminated) this.incomplete = true;
    }
    this.pendingHeredocs = [];
  }

  private readWord(): ShellWord {
    const parts: WordPart[] = [];
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (char === undefined || isWordBreak(char)) break;
      if (char === "\\") {
        const next = this.src[this.pos + 1];
        this.pos += 2;
        if (next === undefined) this.incomplete = true;
        else if (next !== "\n") pushText(parts, next, true);
      } else if (char === "'") {
        this.pos++;
        pushText(parts, this.readUntil("'"), true);
      } else if (char === "$" && this.src[this.pos + 1] === "'") {
        this.pos += 2;
        pushText(parts, this.readAnsiC(), true);
      } else if (char === '"') {
        this.pos++;
        this.readExpandingText(parts, '"');
      } else if (char === "$") {
        this.readDollar(parts);
      } else if (char === "`") {
        this.pos++;
        parts.push({ kind: "substitution", script: this.readBacktick() });
      } else if (char === "~" && parts.length === 0 && this.readTilde(parts)) {
        // handled
      } else {
        pushText(parts, char, false);
        this.pos++;
      }
    }
    return { parts };
  }

  private readTilde(parts: WordPart[]): boolean {
    const match = /^~([A-Za-z0-9._-]*)/.exec(this.src.slice(this.pos));
    const after = this.src[this.pos + (match?.[0].length ?? 1)];
    if (!match || !(after === "/" || isWordBreak(after))) return false;
    parts.push({ kind: "tilde", user: match[1] ?? "" });
    this.pos += match[0].length;
    return true;
  }

  private readUntil(terminator: string): string {
    const end = this.src.indexOf(terminator, this.pos);
    if (end === -1) {
      this.incomplete = true;
      const rest = this.src.slice(this.pos);
      this.pos = this.src.length;
      return rest;
    }
    const text = this.src.slice(this.pos, end);
    this.pos = end + terminator.length;
    return text;
  }

  private readAnsiC(): string {
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'" };
    let text = "";
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (char === "'") {
        this.pos++;
        return text;
      }
      if (char === "\\" && this.pos + 1 < this.src.length) {
        const next = this.src[this.pos + 1] ?? "";
        text += escapes[next] ?? `\\${next}`;
        this.pos += 2;
      } else {
        text += char;
        this.pos++;
      }
    }
    this.incomplete = true;
    return text;
  }

  /**
   * The inside of a double-quoted string, or (with no terminator) a heredoc body: literal text
   * plus the expansions that still happen there.
   */
  readExpandingText(parts: WordPart[], terminator: '"' | null): void {
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (terminator !== null && char === terminator) {
        this.pos++;
        // An empty "" still makes a word.
        if (parts.length === 0) pushText(parts, "", true);
        return;
      }
      if (char === "\\") {
        const next = this.src[this.pos + 1];
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== "\n") pushText(parts, next, true);
          this.pos += 2;
        } else {
          pushText(parts, "\\", true);
          this.pos++;
        }
      } else if (char === "$") {
        this.readDollar(parts);
      } else if (char === "`") {
        this.pos++;
        parts.push({ kind: "substitution", script: this.readBacktick() });
      } else {
        pushText(parts, char ?? "", true);
        this.pos++;
      }
    }
    if (terminator !== null) this.incomplete = true;
  }

  private readDollar(parts: WordPart[]): void {
    const next = this.src[this.pos + 1];
    if (next === "(") {
      const arithmetic = this.src[this.pos + 2] === "(";
      this.pos += 2;
      const script = this.readBalancedParens();
      parts.push(arithmetic ? { kind: "unknown" } : { kind: "substitution", script });
    } else if (next === "{") {
      this.pos += 2;
      const inner = this.readUntil("}");
      parts.push(/^[A-Za-z_]\w*$/.test(inner) ? { kind: "var", name: inner } : { kind: "unknown" });
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      const match = /^[A-Za-z_]\w*/.exec(this.src.slice(this.pos + 1));
      const name = match?.[0] ?? next;
      this.pos += 1 + name.length;
      parts.push({ kind: "var", name });
    } else if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.pos += 2;
      parts.push({ kind: "unknown" });
    } else {
      pushText(parts, "$", true);
      this.pos++;
    }
  }

  /** From just after an opening `(` to its matching `)`; returns the text between. */
  private readBalancedParens(): string {
    const start = this.pos;
    let depth = 1;
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (char === "\\") {
        this.pos += 2;
      } else if (char === "'") {
        this.pos++;
        this.readUntil("'");
      } else if (char === '"') {
        this.pos++;
        this.readExpandingText([], '"');
      } else if (char === "`") {
        this.pos++;
        this.readBacktick();
      } else if (char === "(") {
        depth++;
        this.pos++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) {
          const inner = this.src.slice(start, this.pos);
          this.pos++;
          return inner;
        }
        this.pos++;
      } else {
        this.pos++;
      }
    }
    this.incomplete = true;
    return this.src.slice(start);
  }

  private readBacktick(): string {
    let script = "";
    while (this.pos < this.src.length) {
      const char = this.src[this.pos];
      if (char === "`") {
        this.pos++;
        return script;
      }
      if (char === "\\" && "`\\$".includes(this.src[this.pos + 1] ?? "")) {
        script += this.src[this.pos + 1];
        this.pos += 2;
      } else {
        script += char;
        this.pos++;
      }
    }
    this.incomplete = true;
    return script;
  }
}

// ---------------------------------------------------------------------------------------------
// Parser: tokens into lists of pipelines, with subshells.
// ---------------------------------------------------------------------------------------------

interface SimpleCommand {
  kind: "simple";
  words: ShellWord[];
  redirects: Redirect[];
}

interface Subshell {
  kind: "subshell";
  body: CommandList;
}

type CommandNode = SimpleCommand | Subshell;
type Pipeline = CommandNode[];
type CommandList = Pipeline[];

function emptySimpleCommand(): SimpleCommand {
  return { kind: "simple", words: [], redirects: [] };
}

/**
 * Caps literal `(…)` subshell nesting the recursive-descent parser will follow. Nothing real
 * nests this deep; it exists so a script with thousands of nested parens cannot overflow the
 * stack. Past the cap the nested subshell is skipped rather than walked, which is a miss, not a
 * false positive — consistent with the gate only blocking what it can resolve.
 */
const MAX_PAREN_DEPTH = 200;

/** Skips from just after an unwalked `(` to its matching `)`, without recursing. */
function skipBalancedParenTokens(tokens: ShellToken[], start: number): number {
  let depth = 1;
  let index = start;
  while (index < tokens.length && depth > 0) {
    const token = tokens[index];
    if (token?.type === "op" && token.op === "(") depth++;
    else if (token?.type === "op" && token.op === ")") depth--;
    index++;
  }
  return index;
}

function parseList(
  tokens: ShellToken[],
  start: number,
  inSubshell: boolean,
  parenDepth = 0,
): { list: CommandList; next: number } {
  const list: CommandList = [];
  let pipeline: Pipeline = [];
  let current = emptySimpleCommand();
  const flushCommand = () => {
    if (current.words.length > 0 || current.redirects.length > 0) pipeline.push(current);
    current = emptySimpleCommand();
  };
  const flushPipeline = () => {
    flushCommand();
    if (pipeline.length > 0) list.push(pipeline);
    pipeline = [];
  };

  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    if (token.type === "word") {
      current.words.push(token.word);
      index++;
      continue;
    }
    if (token.type === "redirect") {
      current.redirects.push(token.redirect);
      index++;
      continue;
    }
    if (token.op === "(") {
      if (current.words.length > 0) {
        // `name ()`: a function definition. Its body is parsed as ordinary commands.
        current = emptySimpleCommand();
        const closing = tokens[index + 1];
        index += closing?.type === "op" && closing.op === ")" ? 2 : 1;
        continue;
      }
      flushCommand();
      if (parenDepth >= MAX_PAREN_DEPTH) {
        index = skipBalancedParenTokens(tokens, index + 1);
        continue;
      }
      const inner = parseList(tokens, index + 1, true, parenDepth + 1);
      pipeline.push({ kind: "subshell", body: inner.list });
      index = inner.next;
      continue;
    }
    if (token.op === ")") {
      if (inSubshell) {
        flushPipeline();
        return { list, next: index + 1 };
      }
      // A `case` pattern's closing paren.
      index++;
      continue;
    }
    if (token.op === "|" || token.op === "|&") flushCommand();
    else flushPipeline();
    index++;
  }
  flushPipeline();
  return { list, next: index };
}

// ---------------------------------------------------------------------------------------------
// Evaluation: walk the commands in order, tracking `cd` and assignments, and apply the rules.
// ---------------------------------------------------------------------------------------------

interface EvalContext {
  /** Null once a `cd` goes somewhere we cannot resolve; relative paths are then unknown. */
  cwd: string | null;
  /** Variables assigned earlier in the command; null means assigned to something unknown. */
  vars: Map<string, string | null>;
  home: string | null;
  windowsPaths?: boolean;
}

interface WalkState {
  visitor: ShellVisitor;
  stopped: boolean;
}

export interface ExpandedWord {
  text: string;
  /** False when any part is a value we cannot know. */
  resolved: boolean;
  /** Ends in an unquoted `*` that stands for every entry of a directory (`*` or `dir/*`). */
  globsDirectory: boolean;
}

const MAX_NESTING = 8;

function forkContext(context: EvalContext): EvalContext {
  return { ...context, vars: new Map(context.vars) };
}

function evalScript(script: string, context: EvalContext, state: WalkState, depth: number): void {
  if (depth > MAX_NESTING || state.stopped) return;
  const { tokens } = new ShellTokenizer(script).tokenize();
  evalList(parseList(tokens, 0, false).list, context, state, depth);
}

function evalList(list: CommandList, context: EvalContext, state: WalkState, depth: number): void {
  for (const pipeline of list) {
    // Every element of a real pipeline runs in its own subshell, so a `cd` there stays there.
    const single = pipeline.length === 1;
    for (const [index, node] of pipeline.entries()) {
      if (state.stopped) return;
      const nodeContext = single ? context : forkContext(context);
      if (node.kind === "subshell") {
        evalList(node.body, forkContext(context), state, depth);
        continue;
      }
      const upstream = index > 0 ? pipeline[index - 1] : undefined;
      const piped = upstream?.kind === "simple" ? staticOutput(upstream, context) : undefined;
      evalSimple(node, nodeContext, state, depth, piped);
    }
  }
}

function lookupVar(name: string, context: EvalContext): string | undefined {
  if (context.vars.has(name)) return context.vars.get(name) ?? undefined;
  if (name === "HOME" || (name === "USERPROFILE" && context.windowsPaths)) {
    return context.home ?? undefined;
  }
  if (name === "PWD") return context.cwd ?? undefined;
  if (name === "USER" || name === "LOGNAME") {
    return context.home ? path.posix.basename(context.home) : undefined;
  }
  return undefined;
}

/**
 * `state` null peeks at a word without running its command substitutions — for a pipeline's
 * upstream command, which is evaluated in its own right anyway.
 */
function expandWord(
  word: ShellWord,
  context: EvalContext,
  state: WalkState | null,
  depth: number,
): ExpandedWord {
  let text = "";
  let resolved = true;
  for (const part of word.parts) {
    if (part.kind === "text") {
      text += part.value;
    } else if (part.kind === "var") {
      const value = lookupVar(part.name, context);
      if (value === undefined) resolved = false;
      else text += value;
    } else if (part.kind === "tilde") {
      if (context.home === null) resolved = false;
      else if (part.user === "") text += context.home;
      else text += path.posix.join(path.posix.dirname(context.home), part.user);
    } else if (part.kind === "substitution") {
      if (state) evalScript(part.script, forkContext(context), state, depth + 1);
      resolved = false;
    } else {
      resolved = false;
    }
  }
  const last = word.parts[word.parts.length - 1];
  const globsDirectory =
    last?.kind === "text" &&
    !last.quoted &&
    last.value.endsWith("*") &&
    (text === "*" || text.endsWith("/*"));
  return { text, resolved, globsDirectory };
}

function isAssignment(word: ShellWord): boolean {
  const first = word.parts[0];
  return first?.kind === "text" && !first.quoted && /^[A-Za-z_]\w*=/.test(first.value);
}

function assign(word: ExpandedWord, context: EvalContext): void {
  const equals = word.text.indexOf("=");
  if (equals <= 0) return;
  const name = word.text.slice(0, equals);
  if (!/^[A-Za-z_]\w*$/.test(name)) return;
  context.vars.set(name, word.resolved ? word.text.slice(equals + 1) : null);
}

function evalSimple(
  node: SimpleCommand,
  context: EvalContext,
  state: WalkState,
  depth: number,
  pipedStdin: string | undefined,
): void {
  const words = node.words.map((word) => expandWord(word, context, state, depth));
  if (state.stopped) return;

  let stdin = pipedStdin;
  for (const redirect of node.redirects) {
    if (redirect.heredoc) {
      const body = redirect.heredoc.body ?? "";
      // An unquoted heredoc still runs its $(…) and backticks, whatever reads it.
      if (!redirect.heredoc.quoted) evalHeredocExpansions(body, context, state, depth);
      stdin = body;
      continue;
    }
    if (!redirect.target) continue;
    const target = expandWord(redirect.target, context, state, depth);
    if (redirect.op === "<<<") {
      stdin = target.resolved ? target.text : undefined;
    } else if (OUTPUT_REDIRECTS.has(redirect.op) && state.visitor.outputRedirect(target, context)) {
      state.stopped = true;
    }
    if (state.stopped) return;
  }

  const first = node.words.findIndex((word) => !isAssignment(word));
  if (first === -1) {
    for (const word of words) assign(word, context);
    return;
  }
  evalCommand(words.slice(first), context, state, depth, stdin);
}

function evalHeredocExpansions(
  body: string,
  context: EvalContext,
  state: WalkState,
  depth: number,
): void {
  const parts: WordPart[] = [];
  new ShellTokenizer(body).readExpandingText(parts, null);
  for (const part of parts) {
    if (part.kind === "substitution")
      evalScript(part.script, forkContext(context), state, depth + 1);
  }
}

/** What `echo …` or `printf …` writes, when every argument is known. */
function staticOutput(node: SimpleCommand, context: EvalContext): string | undefined {
  const words = node.words
    .filter((word) => !isAssignment(word))
    .map((word) => expandWord(word, context, null, 0));
  const [head, ...rest] = words;
  if (!head || !words.every((word) => word.resolved)) return undefined;
  const name = commandName(head.text);
  const args = rest.map((word) => word.text);
  if (name === "echo") {
    while (args[0] !== undefined && /^-[neE]+$/.test(args[0])) args.shift();
    return args.join(" ");
  }
  if (name === "printf") {
    if (args[0] === "--") args.shift();
    const format = args.shift();
    if (format === undefined) return undefined;
    const formatted = format.replace(/%[sb%]/g, (spec) =>
      spec === "%%" ? "%" : (args.shift() ?? ""),
    );
    return formatted.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  }
  return undefined;
}

export function commandName(text: string): string {
  return path.posix.basename(text);
}

const SKIPPED_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "fi",
  "done",
  "esac",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh"]);

function evalCommand(
  args: ExpandedWord[],
  context: EvalContext,
  state: WalkState,
  depth: number,
  stdin: string | undefined,
): void {
  let rest = args;
  // Peel wrappers (`sudo`, `env`, `xargs`, …) and keywords until the command that actually runs.
  for (let guard = 0; guard < 32; guard++) {
    const head = rest[0];
    if (!head || !head.resolved) return;
    const name = commandName(head.text);
    const unwrapped = unwrapCommand(name, rest);
    if (unwrapped) {
      rest = unwrapped;
      continue;
    }
    runCommand(name, rest, context, state, depth, stdin);
    return;
  }
}

/** The command a wrapper or keyword runs, or null when `name` is the command itself. */
function unwrapCommand(name: string, args: ExpandedWord[]): ExpandedWord[] | null {
  if (SKIPPED_KEYWORDS.has(name)) return args.slice(1);
  switch (name) {
    case "time":
      return skipFlags(args, 1, new Set());
    case "sudo":
    case "doas":
      return skipFlags(
        args,
        1,
        new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
      );
    case "command":
      // `command -v rm` only prints where rm is.
      return args.some((arg) => arg.text === "-v" || arg.text === "-V")
        ? []
        : skipFlags(args, 1, new Set());
    case "builtin":
    case "nohup":
      return args.slice(1);
    case "exec":
      return skipFlags(args, 1, new Set(["-a"]));
    case "nice":
      return skipFlags(args, 1, new Set(["-n", "--adjustment"]));
    case "caffeinate":
      return skipFlags(args, 1, new Set(["-t", "-w"]));
    case "timeout":
    case "gtimeout":
      // Options, then the duration, then the command.
      return skipFlags(args, 1, new Set(["-s", "-k", "--signal", "--kill-after"])).slice(1);
    case "env":
      return skipEnvPrefix(args);
    case "xargs":
      return skipXargsOptions(args);
    default:
      return null;
  }
}

/** Skips `-x`-style options from `start`, consuming a value for each option in `withValue`. */
function skipFlags(args: ExpandedWord[], start: number, withValue: Set<string>): ExpandedWord[] {
  let index = start;
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) break;
    if (arg.text === "--") return args.slice(index + 1);
    if (!arg.text.startsWith("-") || arg.text === "-") break;
    index += withValue.has(arg.text) ? 2 : 1;
  }
  return args.slice(index);
}

function skipEnvPrefix(args: ExpandedWord[]): ExpandedWord[] {
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) break;
    if (arg.text === "--") {
      index++;
      break;
    }
    if (["-u", "-C", "-P", "-S", "--unset", "--chdir"].includes(arg.text)) index += 2;
    else if (arg.text.startsWith("-") || /^[A-Za-z_]\w*=/.test(arg.text)) index++;
    else break;
  }
  return args.slice(index);
}

function skipXargsOptions(args: ExpandedWord[]): ExpandedWord[] {
  const withValue = new Set(["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "-J", "-R", "-S"]);
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) break;
    if (arg.text === "--") {
      index++;
      break;
    }
    if (!arg.text.startsWith("-")) break;
    index += withValue.has(arg.text) ? 2 : 1;
  }
  return args.slice(index);
}

/** Handles what the shell itself does with a command, then hands it to the visitor. */
function runCommand(
  name: string,
  args: ExpandedWord[],
  context: EvalContext,
  state: WalkState,
  depth: number,
  stdin: string | undefined,
): void {
  if (SHELLS.has(name)) {
    runShell(args, context, state, depth, stdin);
  } else if (name === "eval") {
    const words = args.slice(1);
    if (words.every((word) => word.resolved)) {
      evalScript(words.map((word) => word.text).join(" "), context, state, depth + 1);
    }
  } else if (name === "cd" || name === "pushd") {
    changeDirectory(args, context);
  } else if (name === "popd") {
    context.cwd = null;
  } else if (["export", "declare", "typeset", "local", "readonly"].includes(name)) {
    for (const word of args.slice(1)) assign(word, context);
  } else if (name === "unset") {
    for (const word of args.slice(1)) context.vars.set(word.text, null);
  } else if (state.visitor.command(args, context)) {
    state.stopped = true;
  }
}

/** `bash -c SCRIPT`, or a shell reading a heredoc, herestring or `echo … |` from stdin. */
function runShell(
  args: ExpandedWord[],
  context: EvalContext,
  state: WalkState,
  depth: number,
  stdin: string | undefined,
): void {
  let index = 1;
  let commandString = false;
  let readsStdin = false;
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) break;
    const text = arg.text;
    if (text === "--" || text === "-") {
      index++;
      break;
    }
    if (text.startsWith("--")) {
      index += text === "--rcfile" || text === "--init-file" ? 2 : 1;
      continue;
    }
    if (!/^[-+]./.test(text)) break;
    const letters = text.slice(1);
    if (letters.includes("c")) commandString = true;
    if (letters.includes("s")) readsStdin = true;
    index += /[oO]/.test(letters) ? 2 : 1;
  }
  const operands = args.slice(index);
  if (commandString) {
    const script = operands[0];
    if (script?.resolved) evalScript(script.text, forkContext(context), state, depth + 1);
    return;
  }
  if ((operands.length === 0 || readsStdin) && stdin !== undefined) {
    evalScript(stdin, forkContext(context), state, depth + 1);
  }
}

function changeDirectory(args: ExpandedWord[], context: EvalContext): void {
  const target = args.slice(1).find((arg) => !(arg.resolved && /^-[LPe@]+$/.test(arg.text)));
  if (!target) {
    context.cwd = context.home;
  } else if (!target.resolved || target.text === "-") {
    context.cwd = null;
  } else {
    context.cwd = resolvePath(context.cwd, target.text, context.windowsPaths);
  }
}

export function resolvePath(
  cwd: string | null,
  target: string,
  windowsPaths = false,
): string | null {
  const spelled = windowsPaths ? gitBashPath(target) : target;
  if (spelled.startsWith("/")) return path.posix.resolve(spelled);
  if (cwd === null) return null;
  return path.posix.resolve(cwd, spelled);
}

/**
 * A Windows path as Git Bash spells it: `C:\Users\x` and `C:/Users/x` are `/c/Users/x`. A bare
 * `C:` is the current directory on that drive, not its root, so it stays relative.
 */
export function gitBashPath(windowsPath: string): string {
  const slashed = windowsPath.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\//.exec(slashed);
  if (!drive?.[1]) return slashed;
  return `/${drive[1].toLowerCase()}/${slashed.slice(drive[0].length)}`;
}
