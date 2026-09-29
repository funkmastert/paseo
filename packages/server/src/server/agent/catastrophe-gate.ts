import { homedir } from "node:os";
import path from "node:path";

import { createRunGitCommand, runWithGitCommandPriority } from "../../utils/run-git-command.js";
import {
  type ExpandedWord,
  type ShellContext,
  commandName,
  gitBashPath,
  resolvePath,
  walkShellCommands,
} from "./shell-commands.js";

/**
 * The catastrophe gate (docs/catastrophe-gate.md): refuses exactly two things a fleet agent may
 * never do on its own — rewriting or deleting `main` on a remote, and wiping a disk, a volume or
 * a home directory. Nothing else.
 *
 * Pure rules over a small shell parser: no model, no network, no threshold. A false positive
 * costs more than a miss here, so the parser only blocks what it can resolve. An unknown
 * variable, a script file, or the output of a command substitution is allowed.
 */

export type CatastropheRule =
  | "force-push-main"
  | "delete-main"
  | "rm-disk-root"
  | "find-delete-disk-root"
  | "diskutil-erase"
  | "raw-disk-write"
  | "format-disk";

export interface CatastropheBlock {
  block: true;
  rule: CatastropheRule;
  reason: string;
}

export type CatastropheDecision = { block: false } | CatastropheBlock;

/** The branch checked out in `cwd` (or in `gitDir`), or null when it cannot be told. */
export type CurrentBranchResolver = (cwd: string, gitDir?: string) => Promise<string | null>;

/** Whether `ref` exists in the repository at `cwd` (or `gitDir`), or null when it cannot be told. */
export type LocalRefResolver = (
  cwd: string,
  ref: string,
  gitDir?: string,
) => Promise<boolean | null>;

export interface CatastropheCheckOptions {
  /** Defaults to the daemon's home directory. */
  homeDir?: string;
  /** Defaults to asking git. */
  resolveLocalRef?: LocalRefResolver;
  /** Defaults to the daemon's. On win32 the command is read the way Git Bash reads it. */
  platform?: NodeJS.Platform;
}

export async function checkCatastrophe(
  command: string,
  cwd: string,
  resolveCurrentBranch: CurrentBranchResolver,
  options: CatastropheCheckOptions = {},
): Promise<CatastropheDecision> {
  const home = options.homeDir ?? homedir();
  const windows = (options.platform ?? process.platform) === "win32";
  const state: GateState = { found: null, branchChecks: [], refChecks: [] };
  // Claude Code runs Bash through Git Bash on Windows, where C:\Users\x is /c/Users/x.
  const shellPath = (native: string) => {
    const spelled = windows ? gitBashPath(native) : native;
    return path.posix.isAbsolute(spelled) ? path.posix.resolve(spelled) : null;
  };
  const context: ShellContext = {
    cwd: shellPath(cwd),
    home: shellPath(home),
    ...(windows ? { windowsPaths: true } : {}),
  };
  walkShellCommands(command, context, {
    command: (args, where) => {
      checkCommand(args, where, state);
      return state.found !== null;
    },
    outputRedirect: (target, where) => {
      const device = target.resolved ? rawDiskPath(target.text, where) : null;
      if (device) {
        state.found = {
          rule: "raw-disk-write",
          reason: `it redirects output straight onto the raw disk device ${device}`,
        };
      }
      return state.found !== null;
    },
  });
  if (state.found) return { block: true, ...state.found };

  // The only I/O, and only for a force push whose target depends on the repository: one that
  // names no ref (or names HEAD) rewrites the branch checked out where it runs, and one that
  // carries every branch rewrites main only when the repository has a main to carry.
  const native = (shell: string) => (windows ? windowsNativePath(shell) : shell);
  const seen = new Set<string>();
  for (const check of state.branchChecks) {
    const key = `${check.cwd}\0${check.gitDir ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gitDir = check.gitDir === undefined ? undefined : native(check.gitDir);
    const branch = await resolveCurrentBranch(native(check.cwd), gitDir).catch(() => null);
    if (branch === "main") {
      return {
        block: true,
        rule: "force-push-main",
        reason: `it force-pushes ${check.detail} while main is checked out in ${native(check.cwd)}, which rewrites main on the remote`,
      };
    }
  }
  const resolveLocalRef = options.resolveLocalRef ?? localRefExistsWithGit;
  for (const check of state.refChecks) {
    const key = `${check.cwd}\0${check.gitDir ?? ""}\0${check.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const gitDir = check.gitDir === undefined ? undefined : native(check.gitDir);
    const exists = await Promise.resolve()
      .then(() => resolveLocalRef(native(check.cwd), check.ref, gitDir))
      .catch(() => null);
    if (exists === true && check.forced) {
      return {
        block: true,
        rule: "force-push-main",
        reason: `it force-pushes ${check.detail}, which carries ${check.ref} in ${native(check.cwd)} onto main on the remote`,
      };
    }
    if (exists === false && check.prune) {
      return {
        block: true,
        rule: "delete-main",
        reason: `it prunes ${check.detail}, and ${check.ref} does not exist in ${native(check.cwd)}, which deletes main on the remote`,
      };
    }
  }
  return { block: false };
}

/** `/c/Users/x` back to `C:\Users\x`, for git; a path with no drive is left alone. */
function windowsNativePath(shellPath: string): string {
  const drive = /^\/([a-zA-Z])(?=\/|$)/.exec(shellPath);
  if (!drive?.[1]) return shellPath;
  return path.win32.normalize(`${drive[1].toUpperCase()}:${shellPath.slice(2) || "/"}`);
}

const DENIAL_COMMAND_LIMIT = 2_000;

/** What the agent reads when a command is refused. */
export function formatCatastropheDenial(decision: CatastropheBlock, command: string): string {
  const shown =
    command.length > DENIAL_COMMAND_LIMIT
      ? `${command.slice(0, DENIAL_COMMAND_LIMIT)}… (${command.length} chars)`
      : command;
  return [
    `Blocked by the catastrophe gate (rule: ${decision.rule}): ${decision.reason}.`,
    `Command: ${shown}`,
    "This block is final. Do not work around it: not with another tool, a script file, a heredoc, " +
      "bash -c, a terminal, another agent, or a different spelling of the same command.",
    "If this action is really intended, stop and ask Tyler to run it himself.",
  ].join("\n");
}

const BRANCH_LOOKUP_TIMEOUT_MS = 5_000;
const runGitCommand = createRunGitCommand("catastrophe-gate");

/**
 * `git rev-parse --abbrev-ref HEAD` where the push would run; null on any failure. Runs at high
 * git-command queue priority: this is the only I/O the gate does, and it sits in front of a real
 * `git push -f`, so it must not wait behind the daemon's other git traffic for longer than its
 * own 5 s kill allows.
 */
export async function resolveCurrentBranchWithGit(
  cwd: string,
  gitDir?: string,
): Promise<string | null> {
  const args = [...(gitDir ? [`--git-dir=${gitDir}`] : []), "rev-parse", "--abbrev-ref", "HEAD"];
  try {
    const result = await runWithGitCommandPriority("high", () =>
      runGitCommand(args, { cwd, timeout: BRANCH_LOOKUP_TIMEOUT_MS }),
    );
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * `git rev-parse --verify --quiet <ref>` where the push would run: true when the ref exists,
 * false when git says it does not, null on any other failure. Same priority and kill as the
 * branch lookup.
 */
export async function localRefExistsWithGit(
  cwd: string,
  ref: string,
  gitDir?: string,
): Promise<boolean | null> {
  const args = [
    ...(gitDir ? [`--git-dir=${gitDir}`] : []),
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ];
  try {
    // --verify --quiet exits 1 for a missing ref; 128 (outside a repository) throws.
    const result = await runWithGitCommandPriority("high", () =>
      runGitCommand(args, { cwd, timeout: BRANCH_LOOKUP_TIMEOUT_MS, acceptExitCodes: [0, 1] }),
    );
    if (result.exitCode === 0) return true;
    return result.exitCode === 1 ? false : null;
  } catch {
    return null;
  }
}

interface Finding {
  rule: CatastropheRule;
  reason: string;
}

interface BranchCheck {
  cwd: string;
  gitDir?: string;
  detail: string;
}

/**
 * A push that touches the remote's main via `ref`: `forced` means a matching local `ref` rewrites
 * main (blocked when it exists), `prune` means the push deletes any remote ref with no local
 * counterpart, main included (blocked when `ref` does not exist).
 */
interface RefCheck extends BranchCheck {
  ref: string;
  forced: boolean;
  prune: boolean;
}

interface GateState {
  found: Finding | null;
  branchChecks: BranchCheck[];
  refChecks: RefCheck[];
}

function checkCommand(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  const program = args[0];
  if (!program) return;
  const name = commandName(program.text);
  if (name === "rm") checkRm(args, context, state);
  else if (name === "find") checkFind(args, context, state);
  else if (name === "diskutil") checkDiskutil(args, state);
  else if (name === "dd") checkDd(args, context, state);
  else if (name.startsWith("mkfs") || name.startsWith("newfs")) checkFormat(args, context, state);
  else if (name === "git") checkGit(args, context, state);
}

const DATA_VOLUME = "/system/volumes/data";

/** Why deleting `absolute` wipes a disk, a volume or a home directory; null when it does not. */
function describeProtectedRoot(
  absolute: string,
  home: string | null,
  windows: boolean,
): string | null {
  let lower = absolute.toLowerCase();
  if (windows) {
    if (home !== null && lower === home.toLowerCase()) return "the home directory";
    // Git Bash mounts each drive at /c, /d, …: /c is C:\ and /c/Users/x is C:\Users\x.
    const drive = /^\/[a-z](?=\/|$)/.exec(lower)?.[0];
    if (drive === lower) return "a drive root";
    if (drive) lower = lower.slice(drive.length);
  }
  if (lower === DATA_VOLUME) return "the macOS data volume";
  // The data volume's firmlinks: /System/Volumes/Data/Users/x is /Users/x.
  if (lower.startsWith(`${DATA_VOLUME}/`)) lower = lower.slice(DATA_VOLUME.length);
  // Matched case-insensitively: APFS is, so `/users/x` is `/Users/x`.
  if (lower === "/") return "the filesystem root";
  if (home !== null && lower === home.toLowerCase()) return "the home directory";
  if (lower === "/users") return "every home directory";
  if (/^\/users\/[^/]+$/.test(lower)) return "a home directory";
  if (lower === "/system") return "the operating system";
  if (lower === "/volumes") return "every mounted volume";
  if (/^\/volumes\/[^/]+$/.test(lower)) return "a volume root";
  return null;
}

/** The protected root a delete target names, or null. `dir/*` names everything in `dir`. */
function protectedTarget(
  word: ExpandedWord,
  context: ShellContext,
): { path: string; what: string; everythingIn: boolean } | null {
  const base = word.globsDirectory ? word.text.slice(0, -1) || "." : word.text;
  const absolute = resolvePath(context.cwd, base, context.windowsPaths);
  if (absolute === null) return null;
  const what = describeProtectedRoot(absolute, context.home, context.windowsPaths === true);
  return what ? { path: absolute, what, everythingIn: word.globsDirectory } : null;
}

/** rm refuses any operand whose last component is `.` or `..`, so those delete nothing. */
function endsInDotComponent(text: string, windows: boolean): boolean {
  // Git Bash's rm also splits on `\`.
  const trimmed = (windows ? text.replaceAll("\\", "/") : text).replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return last === "." || last === "..";
}

function checkRm(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  let recursive = false;
  let endOfOptions = false;
  const operands: ExpandedWord[] = [];
  // GNU rm takes options anywhere before `--`.
  for (const arg of args.slice(1)) {
    if (!arg.resolved) {
      operands.push(arg);
    } else if (!endOfOptions && arg.text === "--") {
      endOfOptions = true;
    } else if (!endOfOptions && arg.text.startsWith("--")) {
      if (arg.text === "--recursive") recursive = true;
    } else if (!endOfOptions && arg.text.startsWith("-") && arg.text.length > 1) {
      if (/[rR]/.test(arg.text)) recursive = true;
    } else {
      operands.push(arg);
    }
  }
  if (!recursive) return;
  for (const operand of operands) {
    if (!operand.resolved) continue;
    if (!operand.globsDirectory && endsInDotComponent(operand.text, context.windowsPaths === true))
      continue;
    const target = protectedTarget(operand, context);
    if (target) {
      const subject = target.everythingIn ? `everything in ${target.path}` : target.path;
      state.found = {
        rule: "rm-disk-root",
        reason: `it recursively deletes ${subject} (${target.what})`,
      };
      return;
    }
  }
}

const FIND_LEADING_OPTIONS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Tests that select some files rather than all of them. */
const FIND_NARROWING_TESTS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-lname",
  "-ilname",
  "-mtime",
  "-mmin",
  "-atime",
  "-amin",
  "-ctime",
  "-cmin",
  "-Btime",
  "-Bmin",
  "-size",
  "-empty",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-nouser",
  "-nogroup",
  "-perm",
  "-links",
  "-inum",
  "-samefile",
  "-used",
  "-flags",
  "-xattr",
  "-xattrname",
  "-fstype",
  "-context",
]);

function isFindExpressionStart(arg: ExpandedWord): boolean {
  if (!arg.resolved) return false;
  return (
    (arg.text.startsWith("-") && arg.text.length > 1) || ["(", "!", ")", ","].includes(arg.text)
  );
}

/** Splits `find [options] ROOT… EXPRESSION` into its roots and its expression. */
function splitFindArgs(args: ExpandedWord[]): {
  roots: ExpandedWord[];
  expression: ExpandedWord[];
} {
  let index = 1;
  const roots: ExpandedWord[] = [];
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) break;
    if (FIND_LEADING_OPTIONS.has(arg.text) || /^-O\d$/.test(arg.text)) {
      index++;
    } else if (arg.text === "-D" || arg.text === "-f") {
      // BSD `-f PATH` names a root; GNU `-D FLAGS` takes debug flags.
      const value = args[index + 1];
      if (arg.text === "-f" && value) roots.push(value);
      index += 2;
    } else {
      break;
    }
  }
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!arg || isFindExpressionStart(arg)) break;
    roots.push(arg);
  }
  if (roots.length === 0) roots.push({ text: ".", resolved: true, globsDirectory: false });
  return { roots, expression: args.slice(index) };
}

/** Whether `-exec`, `-execdir`, `-ok` or `-okdir` at `position` runs rm. */
function execRunsRm(expression: ExpandedWord[], position: number): boolean {
  let program = expression[position + 1];
  if (program?.resolved && commandName(program.text) === "sudo") program = expression[position + 2];
  return program?.resolved === true && commandName(program.text) === "rm";
}

/** Where the command started by `-exec` at `position` ends (its `;` or `+`). */
function execEnd(expression: ExpandedWord[], position: number): number {
  let end = position;
  while (end < expression.length && ![";", "+"].includes(expression[end]?.text ?? "")) end++;
  return end;
}

function isNegatedTest(expression: ExpandedWord[], position: number): boolean {
  const previous = expression[position - 1];
  return previous?.resolved === true && (previous.text === "!" || previous.text === "-not");
}

/**
 * `-type f` still selects every regular file, which `-delete`/`-exec rm` can still wipe. Any
 * other value (d, l, p, s, b, c) is not real data: `-type d` with `-delete` only removes empty
 * directories, and the rest name sockets, pipes and dangling symlinks.
 */
function isNarrowingTypeTest(expression: ExpandedWord[], position: number): boolean {
  const value = expression[position + 1];
  return value?.resolved === true && value.text !== "f";
}

/**
 * Whether a find expression deletes every file it reaches: `-delete` or `-exec rm …` with no
 * positive narrowing test. `find ~ -name .DS_Store -delete` is cleanup, not a wipe.
 */
function deletesEverything(expression: ExpandedWord[]): boolean {
  let deletes = false;
  for (let position = 0; position < expression.length; position++) {
    const arg = expression[position];
    if (!arg?.resolved) continue;
    if (arg.text === "-delete") {
      deletes = true;
    } else if (FIND_EXEC_ACTIONS.has(arg.text)) {
      deletes ||= execRunsRm(expression, position);
      // The executed command's own arguments are not find tests.
      position = execEnd(expression, position);
    } else if (arg.text === "-type") {
      if (!isNegatedTest(expression, position) && isNarrowingTypeTest(expression, position))
        return false;
    } else if (FIND_NARROWING_TESTS.has(arg.text) || arg.text.startsWith("-newer")) {
      if (!isNegatedTest(expression, position)) return false;
    }
  }
  return deletes;
}

function checkFind(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  const { roots, expression } = splitFindArgs(args);
  if (!deletesEverything(expression)) return;
  for (const root of roots) {
    const target = root.resolved ? protectedTarget(root, context) : null;
    if (target) {
      state.found = {
        rule: "find-delete-disk-root",
        reason: `it deletes everything under ${target.path} (${target.what})`,
      };
      return;
    }
  }
}

const DISKUTIL_ERASE_VERBS = new Set([
  "erasedisk",
  "erasevolume",
  "zerodisk",
  "randomdisk",
  "secureerase",
  "reformat",
  "partitiondisk",
  "apfs deletecontainer",
  "apfs erasevolume",
]);

function checkDiskutil(args: ExpandedWord[], state: GateState): void {
  const verbWord = args[1];
  if (!verbWord?.resolved) return;
  let verb = verbWord.text;
  let operands = args.slice(2);
  if (verb.toLowerCase() === "apfs") {
    const sub = operands[0];
    if (!sub?.resolved) return;
    verb = `apfs ${sub.text}`;
    operands = operands.slice(1);
  }
  if (!DISKUTIL_ERASE_VERBS.has(verb.toLowerCase())) return;
  // A device from `$(hdiutil attach -nomount ram://…)` is a RAM disk being set up.
  if (operands.some((operand) => !operand.resolved)) return;
  state.found = {
    rule: "diskutil-erase",
    reason: `it erases a disk or volume (diskutil ${verb})`,
  };
}

const RAW_DISK_DEVICE = /^\/dev\/(r?disk\d|sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d)/;

function rawDiskPath(target: string, context: ShellContext): string | null {
  const absolute = resolvePath(context.cwd, target, context.windowsPaths);
  return absolute !== null && RAW_DISK_DEVICE.test(absolute) ? absolute : null;
}

function checkDd(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  for (const arg of args.slice(1)) {
    if (!arg.resolved || !arg.text.startsWith("of=")) continue;
    const device = rawDiskPath(arg.text.slice(3), context);
    if (device) {
      state.found = {
        rule: "raw-disk-write",
        reason: `it writes onto the raw disk device ${device}`,
      };
      return;
    }
  }
}

/** mkfs/newfs over a disk device; formatting an image file is ordinary. */
function checkFormat(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  for (const arg of args.slice(1)) {
    if (!arg.resolved || arg.text.startsWith("-")) continue;
    const device = rawDiskPath(arg.text, context);
    if (device) {
      state.found = { rule: "format-disk", reason: `it formats the disk device ${device}` };
      return;
    }
  }
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);
const PUSH_FORCE_FLAGS = new Set([
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
]);
const PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--push-option", "--receive-pack", "--exec"]);

interface GitLocation {
  cwd: string | null;
  gitDir?: string;
}

function checkGit(args: ExpandedWord[], context: ShellContext, state: GateState): void {
  const location: GitLocation = { cwd: context.cwd };
  let index = 1;
  while (index < args.length) {
    const arg = args[index];
    if (!arg?.resolved) return;
    const text = arg.text;
    if (text === "-C") {
      const dir = args[index + 1];
      location.cwd = dir?.resolved
        ? resolvePath(location.cwd, dir.text, context.windowsPaths)
        : null;
      index += 2;
    } else if (text === "--git-dir" || text.startsWith("--git-dir=")) {
      const value = text === "--git-dir" ? args[index + 1] : { ...arg, text: text.slice(10) };
      const gitDir = value?.resolved
        ? resolvePath(location.cwd, value.text, context.windowsPaths)
        : null;
      if (gitDir === null) location.cwd = null;
      else location.gitDir = gitDir;
      index += text === "--git-dir" ? 2 : 1;
    } else if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(text)) {
      index += 2;
    } else if (text.startsWith("-")) {
      index++;
    } else {
      break;
    }
  }
  const subcommand = args[index];
  if (!subcommand?.resolved || subcommand.text !== "push") return;
  checkGitPush(args.slice(index + 1), location, state);
}

function isMainRef(ref: string): boolean {
  return ref === "main" || ref === "refs/heads/main" || ref === "heads/main";
}

interface PushArgs {
  force: boolean;
  deletes: boolean;
  dryRun: boolean;
  /** `--tags` pushes only `refs/tags/*`, so it never touches the current branch. */
  tags: boolean;
  /** Deletes any remote ref with no matching local one, main included. */
  prune: boolean;
  /** `--mirror`, `--all` or `--branches`: every local branch, whatever is checked out. */
  everyBranch: string | null;
  /** The repository, then the refspecs. */
  operands: ExpandedWord[];
}

/** Applies bundled short flags (`-uf`, `-fn`); returns whether `-o` took the next word. */
function readShortPushFlags(text: string, push: PushArgs): boolean {
  for (let letter = 1; letter < text.length; letter++) {
    const flag = text[letter];
    if (flag === "f") push.force = true;
    else if (flag === "d") push.deletes = true;
    else if (flag === "n") push.dryRun = true;
    // `-o` takes the rest of the word as its value, or the next word.
    else if (flag === "o") return letter === text.length - 1;
  }
  return false;
}

/** Sets the boolean fields a recognized long push flag turns on; false for anything else. */
function applyLongPushFlag(name: string, push: PushArgs): boolean {
  if (name === "--mirror" || name === "--all" || name === "--branches") push.everyBranch = name;
  if (PUSH_FORCE_FLAGS.has(name)) {
    push.force = true;
  } else if (name === "--delete") {
    push.deletes = true;
  } else if (name === "--dry-run") {
    push.dryRun = true;
  } else if (name === "--prune") {
    push.prune = true;
  } else if (name === "--tags") {
    // `--follow-tags` also pushes the current branch, so it is not `--tags`.
    push.tags = true;
  } else {
    return false;
  }
  return true;
}

function parsePushArgs(args: ExpandedWord[]): PushArgs {
  const push: PushArgs = {
    force: false,
    deletes: false,
    dryRun: false,
    tags: false,
    prune: false,
    everyBranch: null,
    operands: [],
  };
  let endOfOptions = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    const text = arg.text;
    if (!arg.resolved || endOfOptions || !text.startsWith("-") || text === "-") {
      push.operands.push(arg);
    } else if (text === "--") {
      endOfOptions = true;
    } else if (text.startsWith("--")) {
      const name = text.split("=", 1)[0] ?? text;
      if (
        !applyLongPushFlag(name, push) &&
        PUSH_OPTIONS_WITH_VALUE.has(name) &&
        !text.includes("=")
      )
        index++;
    } else if (readShortPushFlags(text, push)) {
      index++;
    }
  }
  return push;
}

/**
 * What one refspec does to main: a finding, a branch lookup (for HEAD), a local ref lookup (for
 * a refspec that pushes many branches), or nothing.
 */
function classifyRefspec(
  refspec: string,
  push: PushArgs,
): Finding | "current-branch" | { ref: string } | null {
  const forced = push.force || refspec.startsWith("+");
  const spec = refspec.replace(/^\+/, "");
  if (push.deletes) {
    return isMainRef(spec)
      ? { rule: "delete-main", reason: `it deletes main on the remote (--delete ${spec})` }
      : null;
  }
  const colon = spec.indexOf(":");
  const source = colon === -1 ? spec : spec.slice(0, colon);
  const destination = colon === -1 ? spec : spec.slice(colon + 1);
  if (colon === -1 && forced && (spec === "HEAD" || spec === "@")) return "current-branch";
  // `:` pushes every branch that exists on both sides, main among them.
  if (spec === ":") return forced ? { ref: "refs/heads/main" } : null;
  if (spec.includes("*")) {
    // A pattern refspec with `--prune` deletes the remote's main when the repository has no
    // matching local ref to push there, whether or not the push is forced.
    const ref = forced || push.prune ? patternSourceOfMain(source, destination) : null;
    return ref ? { ref } : null;
  }
  if (!isMainRef(destination)) return null;
  if (source === "") {
    return { rule: "delete-main", reason: `it deletes main on the remote (refspec ${refspec})` };
  }
  return forced
    ? {
        rule: "force-push-main",
        reason: `it force-updates main on the remote (refspec ${refspec})`,
      }
    : null;
}

const REMOTE_MAIN = "refs/heads/main";

/**
 * The local ref a pattern refspec pushes onto the remote's main: `refs/heads/main` for
 * `refs/heads/*:refs/heads/*` or `refs/*:refs/*`, `refs/remotes/origin/main` for
 * `refs/remotes/origin/*:refs/heads/*`. Null when the destination pattern cannot name main.
 */
function patternSourceOfMain(source: string, destination: string): string | null {
  const [prefix, suffix, extra] = destination.split("*");
  const [sourcePrefix, sourceSuffix, sourceExtra] = source.split("*");
  if (prefix === undefined || suffix === undefined || extra !== undefined) return null;
  if (sourcePrefix === undefined || sourceSuffix === undefined || sourceExtra !== undefined)
    return null;
  if (REMOTE_MAIN.length <= prefix.length + suffix.length) return null;
  if (!REMOTE_MAIN.startsWith(prefix) || !REMOTE_MAIN.endsWith(suffix)) return null;
  const matched = REMOTE_MAIN.slice(prefix.length, REMOTE_MAIN.length - suffix.length);
  return `${sourcePrefix}${matched}${sourceSuffix}`;
}

function checkGitPush(args: ExpandedWord[], location: GitLocation, state: GateState): void {
  const push = parsePushArgs(args);
  if (push.dryRun) return;
  // `--mirror` is `+refs/*:refs/*` plus prune: it force-updates the remote's main when the
  // repository has one, and deletes it otherwise. Both outcomes are catastrophic, so it blocks
  // outright rather than by local-ref lookup; the fleet replay found no real use of it.
  if (push.everyBranch === "--mirror") {
    state.found = {
      rule: "force-push-main",
      reason:
        "it mirrors every ref onto the remote (--mirror), which force-updates or deletes main there",
    };
    return;
  }
  // A forced `--all`/`--branches` is `+refs/heads/*:refs/heads/*`: it rewrites the remote's main
  // from any branch, if the repository has a main to push. `--prune` with `--all`/`--branches`
  // deletes the remote's main outright when the repository does not, forced or not.
  if (push.everyBranch !== null && (push.force || push.prune)) {
    addRefCheck(location, REMOTE_MAIN, `with ${push.everyBranch}`, state, {
      forced: push.force,
      prune: push.prune,
    });
    return;
  }
  const refspecs = push.operands.slice(1);
  if (refspecs.length === 0) {
    // `--tags` appends `refs/tags/*` as its own refspec, so a bare push with no other refspec
    // pushes tags, not the current branch.
    if (push.force && !push.deletes && !push.tags)
      addBranchCheck(location, "with no refspec", state);
    return;
  }
  for (const refspec of refspecs) {
    if (!refspec.resolved) continue;
    const outcome = classifyRefspec(refspec.text, push);
    if (outcome === "current-branch") {
      addBranchCheck(location, refspec.text, state);
    } else if (outcome && "ref" in outcome) {
      addRefCheck(location, outcome.ref, `refspec ${refspec.text}`, state, {
        forced: push.force || refspec.text.startsWith("+"),
        prune: push.prune,
      });
    } else if (outcome) {
      state.found = outcome;
      return;
    }
  }
}

function addBranchCheck(location: GitLocation, detail: string, state: GateState): void {
  if (location.cwd === null) return;
  state.branchChecks.push({
    cwd: location.cwd,
    ...(location.gitDir ? { gitDir: location.gitDir } : {}),
    detail,
  });
}

function addRefCheck(
  location: GitLocation,
  ref: string,
  detail: string,
  state: GateState,
  flags: { forced: boolean; prune: boolean },
): void {
  if (location.cwd === null) return;
  state.refChecks.push({
    cwd: location.cwd,
    ...(location.gitDir ? { gitDir: location.gitDir } : {}),
    detail,
    ref,
    forced: flags.forced,
    prune: flags.prune,
  });
}
