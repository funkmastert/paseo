/**
 * Recognizes a shell command that runs a native mobile build, so the build gate can decide
 * before the build starts (docs/resource-monitor.md, "The native build gate"). Pure and narrow,
 * with device-launch-commands.ts's discipline: whole argv tokens of the command being run, never
 * a string that happens to contain one. `pgrep -fl xcodebuild` and `pkill -f "xcodebuild test"`
 * are not builds. A false positive refuses work; a false negative is counted by the process scan
 * (native-build-detection.ts) once the build is running, and the next build waits for it.
 *
 * The argument classifiers are exported for that scan, which reads the same arguments off `ps`.
 */

import {
  basename,
  stripCommandPrefixes,
  tokenizeCommandSegments,
} from "./device-launch-commands.js";

export type NativeBuildTool =
  | "gradle"
  | "xcodebuild"
  | "swift"
  | "expo"
  | "react-native"
  | "eas"
  | "package-script";

/**
 * What runs the build, as whole tokens a process in the agent's tree carries while the command
 * runs: the program's basename and, when the command names one, its task, action or script. The
 * gate keeps a build's slot while a process with both is alive (native-build-gate.ts): the shell
 * running the command, `heavy.sh` waiting for its slot, an `expo run` still in prebuild.
 */
export interface BuildLauncher {
  program: string;
  argument?: string;
}

export interface NativeBuildIntent {
  tool: NativeBuildTool;
  /** The build as a denial names it: `gradlew :app:assembleDebug`, `xcodebuild test`. */
  command: string;
  launcher: BuildLauncher;
}

// --- Gradle ---------------------------------------------------------------------------------

/**
 * Flags that make a run something other than one build: `--stop`, `-v`, a dry run, and
 * `--continuous`, which watches and rebuilds until it is killed and so would hold a slot for its
 * whole life.
 */
const GRADLE_NON_BUILD_FLAGS = new Set([
  "--continuous",
  "-t",
  "--stop",
  "--status",
  "--version",
  "-v",
  "--help",
  "-h",
  "-?",
  "--dry-run",
  "-m",
]);

/** Flags whose value is the next token, so the value is never read as a task. */
const GRADLE_VALUE_FLAGS = new Set([
  "-x",
  "--exclude-task",
  "--tests",
  "-p",
  "--project-dir",
  "-b",
  "--build-file",
  "-c",
  "--settings-file",
  "-g",
  "--gradle-user-home",
  "-I",
  "--init-script",
  "--console",
  "--warning-mode",
  "--max-workers",
  "--priority",
  "--include-build",
  "--project-cache-dir",
  // Options of the `help` and `dependencies` tasks.
  "--task",
  "--configuration",
  "--dependency",
]);

/**
 * Tasks that compile, package, install or test. Anything else (`tasks`, `projects`,
 * `dependencies`, `clean`, `ktlintCheck`, `signingReport`) does not count.
 */
const GRADLE_BUILD_TASK =
  /^(assemble|bundle|install|test|connected|compile|lint|package|check$|build$|build(?!Environment)[A-Z]|(verify|record|compare)Roborazzi)/;

/**
 * The first task in a Gradle argument list that builds, or undefined when none does or a flag
 * makes the run read-only. Shared with the process scan, which reads a Gradle client's arguments
 * off `ps`.
 */
export function findGradleBuildTask(args: readonly string[]): string | undefined {
  if (args.some((arg) => GRADLE_NON_BUILD_FLAGS.has(arg))) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (GRADLE_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    const task = arg.split(":").pop() ?? "";
    if (GRADLE_BUILD_TASK.test(task)) return arg;
  }
  return undefined;
}

function matchGradle(tokens: readonly string[]): NativeBuildIntent | undefined {
  const program = basename(tokens[0] ?? "");
  if (program !== "gradlew" && program !== "gradle") return undefined;
  const task = findGradleBuildTask(tokens.slice(1));
  return task
    ? { tool: "gradle", command: `${program} ${task}`, launcher: { program, argument: task } }
    : undefined;
}

// --- xcodebuild -----------------------------------------------------------------------------

/**
 * Modes that inspect, export or locate without building. `-license` waits at its prompt for as
 * long as nobody answers, so it must never count as a build.
 */
const XCODEBUILD_READ_ONLY_FLAGS = new Set([
  "-license",
  "-find",
  "-find-executable",
  "-find-library",
  "-showBuildSettingsForIndex",
  "-list",
  "-showBuildSettings",
  "-showdestinations",
  "-showsdks",
  "-showTestPlans",
  "-version",
  "-usage",
  "-help",
  "-h",
  "-checkFirstLaunchStatus",
  "-runFirstLaunch",
  "-resolvePackageDependencies",
  "-exportArchive",
  "-exportLocalizations",
  "-importLocalizations",
  "-create-xcframework",
  "-downloadPlatform",
  "-downloadAllPlatforms",
  "-showComponent",
  "-importPlatform",
]);

/** Flags whose value is the next token. A scheme named `test` is not the test action. */
const XCODEBUILD_VALUE_FLAGS = new Set([
  "-project",
  "-workspace",
  "-scheme",
  "-target",
  "-configuration",
  "-sdk",
  "-arch",
  "-destination",
  "-destination-timeout",
  "-derivedDataPath",
  "-resultBundlePath",
  "-xcconfig",
  "-testPlan",
  "-only-testing",
  "-skip-testing",
  "-archivePath",
  "-exportPath",
  "-exportOptionsPlist",
  "-toolchain",
  "-xctestrun",
  "-testProductsPath",
  "-jobs",
  "-parallel-testing-worker-count",
  "-test-iterations",
  "-clonedSourcePackagesDirPath",
  "-packageCachePath",
  "-enableCodeCoverage",
  "-parallel-testing-enabled",
]);

const XCODEBUILD_BUILD_ACTIONS = new Set([
  "build",
  "build-for-testing",
  "analyze",
  "archive",
  "test",
  "test-without-building",
  "docbuild",
  "install",
]);
const XCODEBUILD_OTHER_ACTIONS = new Set(["clean", "installsrc"]);

/**
 * The xcodebuild action that builds (`build`, `test`, `archive`, ...), `build` when no action is
 * named (xcodebuild's default), or undefined for an inspection or a clean. Shared with the scan.
 */
export function findXcodebuildBuildAction(args: readonly string[]): string | undefined {
  if (args.some((arg) => XCODEBUILD_READ_ONLY_FLAGS.has(arg))) return undefined;
  const actions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (XCODEBUILD_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (XCODEBUILD_BUILD_ACTIONS.has(arg) || XCODEBUILD_OTHER_ACTIONS.has(arg)) actions.push(arg);
  }
  if (actions.length === 0) return "build";
  return actions.find((action) => XCODEBUILD_BUILD_ACTIONS.has(action));
}

/**
 * `xcodebuild`, and a wrapper script named for it whose arguments pass through to it, such as
 * `scripts/run-xcodebuild-with-package-retry.sh -workspace ... -scheme ...`.
 */
function matchXcodebuild(tokens: readonly string[]): NativeBuildIntent | undefined {
  const program = basename(tokens[0] ?? "");
  const isWrapper = program.includes("xcodebuild") && program.endsWith(".sh");
  if (program !== "xcodebuild" && !isWrapper) return undefined;
  const args = tokens.slice(1);
  const action = findXcodebuildBuildAction(args);
  if (!action) return undefined;
  const named = args.includes(action) ? { argument: action } : {};
  return {
    tool: "xcodebuild",
    command: `xcodebuild ${action}`,
    launcher: { program, ...named },
  };
}

// --- SwiftPM --------------------------------------------------------------------------------

const SWIFT_READ_ONLY_FLAGS = new Set(["--show-bin-path", "--help", "-h", "--version"]);

/**
 * `build` or `test` for `swift build|test` and the `swift-build`, `swift-test` binaries; undefined
 * for anything else or a read-only flag. `tokens` starts at the program. Shared with the scan.
 * `swift run` does not count: it builds and then runs the product, often a server that never
 * exits, and would hold a slot for its life.
 */
export function findSwiftBuildSubcommand(tokens: readonly string[]): string | undefined {
  const program = basename(tokens[0] ?? "");
  const isDriver = program === "swift";
  const subcommand = isDriver ? tokens[1] : /^swift-(build|test)$/.exec(program)?.[1];
  if (subcommand !== "build" && subcommand !== "test") return undefined;
  const args = tokens.slice(isDriver ? 2 : 1);
  return args.some((arg) => SWIFT_READ_ONLY_FLAGS.has(arg)) ? undefined : subcommand;
}

function matchSwift(tokens: readonly string[]): NativeBuildIntent | undefined {
  const subcommand = findSwiftBuildSubcommand(tokens);
  if (!subcommand) return undefined;
  const program = basename(tokens[0] ?? "");
  return {
    tool: "swift",
    command: `swift ${subcommand}`,
    launcher: program === "swift" ? { program, argument: subcommand } : { program },
  };
}

// --- JS runners -----------------------------------------------------------------------------

const RUNNER_BUILDS: ReadonlyArray<{ program: string; subcommand: RegExp; tool: NativeBuildTool }> =
  [
    { program: "expo", subcommand: /^run:(ios|android)$/, tool: "expo" },
    { program: "react-native", subcommand: /^(run|build)-(ios|android)$/, tool: "react-native" },
  ];

/** `npx expo run:ios`, `pnpm exec react-native run-android`, `eas build --local`. */
function matchRunner(tokens: readonly string[]): NativeBuildIntent | undefined {
  let rest = tokens;
  const first = basename(rest[0] ?? "");
  if (["npx", "bunx"].includes(first)) {
    rest = rest.slice(1);
  } else if (["pnpm", "yarn", "bun", "npm"].includes(first)) {
    rest = ["exec", "dlx", "x"].includes(rest[1] ?? "") ? rest.slice(2) : rest.slice(1);
  }
  while (rest[0]?.startsWith("-")) rest = rest.slice(1);
  const program = basename(rest[0] ?? "");
  const subcommand = rest[1] ?? "";
  // A cloud EAS build runs elsewhere; only `--local` builds on this machine.
  if (program === "eas" && subcommand === "build") {
    return rest.includes("--local")
      ? {
          tool: "eas",
          command: "eas build --local",
          launcher: { program: "eas", argument: "build" },
        }
      : undefined;
  }
  const match = RUNNER_BUILDS.find(
    (entry) => entry.program === program && entry.subcommand.test(subcommand),
  );
  return match
    ? {
        tool: match.tool,
        command: `${program} ${subcommand}`,
        launcher: { program, argument: subcommand },
      }
    : undefined;
}

// --- Package scripts ------------------------------------------------------------------------

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Scripts that end in a native build, such as this repo's own `android` and `ios`. */
const NATIVE_BUILD_SCRIPT = /^(android|ios)(:|$)|^build:(android|ios)/;
/** Package manager flags whose value is the next token. */
const PACKAGE_MANAGER_VALUE_FLAGS = new Set([
  "--prefix",
  "-C",
  "--dir",
  "--cwd",
  "--filter",
  "-F",
  "--workspace",
  "-w",
]);

/** `npm run android`, `yarn ios`, `pnpm --filter app run build:android`, `bun run ios`. */
function matchPackageScript(tokens: readonly string[]): NativeBuildIntent | undefined {
  const program = basename(tokens[0] ?? "");
  if (!PACKAGE_MANAGERS.has(program)) return undefined;
  let index = 1;
  const skipFlags = () => {
    while (tokens[index]?.startsWith("-")) {
      index += PACKAGE_MANAGER_VALUE_FLAGS.has(tokens[index] ?? "") ? 2 : 1;
    }
  };
  skipFlags();
  if (program === "yarn" && tokens[index] === "workspace") {
    index += 2;
    skipFlags();
  }
  const viaRun = tokens[index] === "run" || tokens[index] === "run-script";
  if (viaRun) {
    index += 1;
    skipFlags();
  } else if (program === "npm") {
    // npm runs a script only through `run`; `npm install` and `npm test` are not builds.
    return undefined;
  }
  const script = tokens[index];
  if (!script || !NATIVE_BUILD_SCRIPT.test(script)) return undefined;
  return {
    tool: "package-script",
    command: `${program}${viaRun ? " run" : ""} ${script}`,
    launcher: { program, argument: script },
  };
}

// --- Wrappers -------------------------------------------------------------------------------

/** Shell keywords that can stand before the command in a segment. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

/** `timeout`'s options that take a value. */
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** How deep `bash -c "sh -c '...'"` is followed. */
const MAX_SHELL_DEPTH = 3;

/** The script a shell runs with `-c` (`bash -lc '...'`); undefined when it runs none. */
function shellScript(tokens: readonly string[]): string | undefined {
  if (!SHELLS.has(basename(tokens[0] ?? ""))) return undefined;
  for (let index = 1; tokens[index]?.startsWith("-"); index += 1) {
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[index] ?? "")) return tokens[index + 1];
  }
  return undefined;
}

/**
 * Strips what runs the build without being it: shell keywords and a subshell's `(`, `nice`,
 * `timeout`, `caffeinate`, this fleet's `heavy.sh` slot wrapper, `xcrun` before xcodebuild or
 * swift, a shell running a script file (`bash ./gradlew`), and `cmd /c`. Repeats, because they
 * nest: `nice -n 10 heavy.sh xcrun xcodebuild test`. A shell running `-c` is left for
 * detectNativeBuildIntents, which reads the script it runs.
 */
function stripBuildWrappers(input: readonly string[]): string[] {
  let tokens = stripCommandPrefixes(input);
  for (;;) {
    const first = tokens[0];
    if (first === undefined) return tokens;
    if (first.startsWith("(")) {
      const unwrapped = first.replace(/^\(+/, "");
      tokens = stripCommandPrefixes(unwrapped ? [unwrapped, ...tokens.slice(1)] : tokens.slice(1));
      continue;
    }
    if (SHELL_KEYWORDS.has(first)) {
      tokens = stripCommandPrefixes(tokens.slice(1));
      continue;
    }
    const program = basename(first);
    let rest: string[] | undefined;
    if (program === "nice") rest = skipNiceOptions(tokens.slice(1));
    else if (program === "timeout" || program === "gtimeout")
      rest = skipTimeoutOptions(tokens.slice(1));
    else if (program === "caffeinate") rest = skipCaffeinateOptions(tokens.slice(1));
    else if (program === "heavy.sh") rest = tokens.slice(1);
    else if (SHELLS.has(program) && shellScript(tokens) === undefined) {
      rest = skipShellOptions(tokens.slice(1));
    } else if (program === "cmd" && /^\/[ck]$/i.test(tokens[1] ?? "")) rest = tokens.slice(2);
    else if (program === "xcrun" && ["xcodebuild", "swift"].includes(basename(tokens[1] ?? ""))) {
      rest = tokens.slice(1);
    }
    if (rest === undefined) return tokens;
    tokens = stripCommandPrefixes(rest);
  }
}

/** `bash -x ./gradlew build`: the options before the script file. */
function skipShellOptions(tokens: string[]): string[] | undefined {
  let index = 0;
  while (tokens[index]?.startsWith("-")) index += 1;
  return index < tokens.length ? tokens.slice(index) : undefined;
}

function skipNiceOptions(tokens: string[]): string[] {
  if (tokens[0] === "-n") return tokens.slice(2);
  if (/^(-n?\d+|--adjustment=.*)$/.test(tokens[0] ?? "")) return tokens.slice(1);
  return tokens;
}

/** `timeout [options] DURATION command`. */
function skipTimeoutOptions(tokens: string[]): string[] {
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += TIMEOUT_VALUE_FLAGS.has(tokens[index] ?? "") ? 2 : 1;
  }
  return tokens.slice(index + 1);
}

function skipCaffeinateOptions(tokens: string[]): string[] {
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += ["-t", "-w"].includes(tokens[index] ?? "") ? 2 : 1;
  }
  return tokens.slice(index);
}

const MATCHERS = [matchGradle, matchXcodebuild, matchSwift, matchRunner, matchPackageScript];

/**
 * PowerShell runs a file in the current directory as `.\gradlew.bat`, and the shared tokenizer
 * reads `\` as an escape (`.gradlew.bat`). A `.\` that starts a word becomes `./`.
 */
function normalizeRelativeWindowsPaths(command: string): string {
  return command.replace(/(^|[\s;&|(])\.\\(?=[\w.-])/g, "$1./");
}

/**
 * Every native build a shell command would run, one per segment that runs one. A chained
 * `./gradlew assembleDebug && ./gradlew installDebug` runs its builds one after the other, so
 * the gate asks for one slot whatever the count.
 */
export function detectNativeBuildIntents(command: string, depth = 0): NativeBuildIntent[] {
  const intents: NativeBuildIntent[] = [];
  for (const segment of tokenizeCommandSegments(normalizeRelativeWindowsPaths(command))) {
    const tokens = stripBuildWrappers(segment);
    if (tokens.length === 0) continue;
    const script = shellScript(tokens);
    if (script !== undefined) {
      if (depth < MAX_SHELL_DEPTH) intents.push(...detectNativeBuildIntents(script, depth + 1));
      continue;
    }
    for (const matcher of MATCHERS) {
      const intent = matcher(tokens);
      if (intent) {
        intents.push(intent);
        break;
      }
    }
  }
  return intents;
}
