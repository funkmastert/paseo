/**
 * Counts the native builds running on the machine from one `ps` sample: the build gate's count
 * (docs/resource-monitor.md, "The native build gate"). The process scan is the count, as it is for
 * the device cap: a build the gate allowed but that never started holds nothing, and a build
 * somebody ran by hand holds a slot like an agent's.
 *
 * What counts:
 *
 *   - **A Gradle client JVM** with a build task in its arguments: `gradlew`'s
 *     `-jar .../gradle-wrapper.jar` (Gradle 8.14 and later), the distribution's
 *     `-jar .../gradle-gradle-cli-main-*.jar`, or the older `GradleWrapperMain`/`GradleMain` main
 *     classes. The client lives exactly as long as the build. The Gradle daemon does not count:
 *     it stays resident between builds, and `ps` cannot tell an idle one from a busy one.
 *   - **`xcodebuild`** running a build action, and **SwiftPM** (`swift build|test`,
 *     `swift-build`).
 *   - **`swift-frontend` compile jobs** under none of those, one build per parent process. That
 *     is an Xcode IDE build. Indexing (`-index-file`) and script (`-interpret`) jobs do not count.
 *
 * A build under another counted build counts once: `swift build` and its `swift-build`, the
 * compile jobs of an `xcodebuild`.
 *
 * Runners are reported apart from builds: `expo run:*`, `react-native run-*|build-*` and
 * `eas build --local`. They spend minutes in prebuild and pods before their native build starts,
 * and `expo run` then stays up serving Metro, so whether one holds a slot is the gate's call
 * (native-build-gate.ts). The build a runner starts is counted as a build, and the runner reads
 * `building` while it runs.
 *
 * On Windows a row is Win32_Process.CommandLine, where paths are double-quoted rather than split
 * on their spaces, so a Windows row is tokenized quote-aware.
 */

import { basename } from "./device-launch-commands.js";
import {
  findGradleBuildTask,
  findSwiftBuildSubcommand,
  findXcodebuildBuildAction,
} from "./native-build-commands.js";
import type { AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

export interface NativeBuildScan {
  /** Builds running now, each counted once. */
  builds: RunningNativeBuild[];
  runners: RunningBuildRunner[];
}

export interface RunningBuildRunner extends RunningNativeBuild {
  /** A counted build is running under it now. */
  building: boolean;
}

export interface RunningNativeBuild {
  /** The build's root process; for an Xcode IDE build, the build service its compiles run under. */
  pid: number;
  /** As a denial names it: `gradlew :app:assembleDebug`, `xcodebuild test`. */
  command: string;
  /** `ps` etime of that process: how long the build has been running. */
  etime: string;
  /** The agent whose process tree runs it; undefined for one started outside every agent. */
  agentId?: string;
}

const GRADLE_LAUNCHER_CLASSES: ReadonlyMap<string, string> = new Map([
  ["org.gradle.wrapper.GradleWrapperMain", "gradlew"],
  ["org.gradle.launcher.GradleMain", "gradle"],
]);
/** How far up the parent chain a build is looked for. */
const MAX_ANCESTRY_DEPTH = 64;
/** A path's head: `/usr`, `C:\\`, `\\\\server`. */
const PATH_HEAD = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const JS_HOSTS = new Set(["node", "nodejs", "bun"]);

/**
 * A row's argv. macOS and Linux `ps` joins argv with spaces, so it splits on whitespace; a Windows
 * row keeps the double quotes cmd puts around paths with spaces, so it splits outside them and
 * drops the quotes. Windows rows are the ones that carry an image `name`.
 */
export function tokenizeProcessRow(row: ProcessSampleRow): string[] {
  if (row.name === undefined) return row.command.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let hasToken = false;
  for (const char of row.command) {
    if (char === '"') {
      quoted = !quoted;
      hasToken = true;
    } else if (!quoted && /\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * `ps` joins argv with spaces, and the paths here (`Android Studio.app`, `Xcode 26.app`) can hold
 * them, so the program is the first token whose basename is `name`, provided everything before it
 * reads as the rest of one path: the line starts with a path, and no later piece of it is a flag
 * or a path of its own (`node /usr/local/bin/npx expo` runs npx, not expo).
 */
function programIndex(tokens: readonly string[], name: string): number {
  return tokenIndexAsProgram(tokens, (token) => basename(token) === name);
}

function tokenIndexAsProgram(
  tokens: readonly string[],
  matches: (token: string) => boolean,
): number {
  const index = tokens.findIndex(matches);
  if (index <= 0) return index;
  const head = tokens.slice(0, index);
  const onePath =
    PATH_HEAD.test(head[0] ?? "") &&
    head.slice(1).every((token) => !token.startsWith("-") && !PATH_HEAD.test(token));
  return onePath ? index : -1;
}

/** The Gradle client's own arguments, after its launcher jar or main class. */
function gradleClientArgs(
  tokens: readonly string[],
): { launcher: string; args: readonly string[] } | undefined {
  const javaIndex = programIndex(tokens, "java");
  if (javaIndex < 0) return undefined;
  for (let index = javaIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const launcher = GRADLE_LAUNCHER_CLASSES.get(token);
    if (launcher) return { launcher, args: tokens.slice(index + 1) };
    if (token !== "-jar") continue;
    // A jar path with spaces arrives split; its last piece is the one ending in `.jar`.
    const jarIndex = tokens.findIndex((candidate, at) => at > index && candidate.endsWith(".jar"));
    if (jarIndex < 0) return undefined;
    const jar = basename(tokens[jarIndex] ?? "");
    if (jar === "gradle-wrapper.jar")
      return { launcher: "gradlew", args: tokens.slice(jarIndex + 1) };
    if (/^gradle-(gradle-cli-main|launcher)-.*\.jar$/.test(jar)) {
      return { launcher: "gradle", args: tokens.slice(jarIndex + 1) };
    }
    return undefined;
  }
  return undefined;
}

/** The build a row's process is the root of, as a denial names it; undefined when it is none. */
function classifyBuildRoot(tokens: readonly string[]): string | undefined {
  const gradle = gradleClientArgs(tokens);
  if (gradle) {
    const task = findGradleBuildTask(gradle.args);
    return task ? `${gradle.launcher} ${task}` : undefined;
  }
  const xcodebuild = programIndex(tokens, "xcodebuild");
  if (xcodebuild >= 0) {
    const action = findXcodebuildBuildAction(tokens.slice(xcodebuild + 1));
    return action ? `xcodebuild ${action}` : undefined;
  }
  const swift = ["swift", "swift-build", "swift-test", "swift-run"]
    .map((name) => programIndex(tokens, name))
    .find((index) => index >= 0);
  if (swift === undefined) return undefined;
  const subcommand = findSwiftBuildSubcommand(tokens.slice(swift));
  return subcommand ? `swift ${subcommand}` : undefined;
}

function isCompileJob(tokens: readonly string[]): boolean {
  return (
    programIndex(tokens, "swift-frontend") >= 0 &&
    tokens.includes("-frontend") &&
    !tokens.includes("-index-file") &&
    !tokens.includes("-interpret")
  );
}

/** Which runner a script path is: `.bin/expo`, Windows' `expo\bin\cli`, `react-native/cli.js`. */
function runnerScript(token: string): "expo" | "react-native" | "eas" | undefined {
  const name = basename(token);
  if (name === "expo" || name === "react-native" || name === "eas") return name;
  if (/[\\/]expo[\\/]bin[\\/]cli(\.js)?$/.test(token)) return "expo";
  if (/[\\/]react-native[\\/]cli\.js$/.test(token)) return "react-native";
  return undefined;
}

/**
 * The runner a row's process is, as a denial names it: the runner script as the program, or run
 * by node or bun. `npx expo run:ios` is not one (npx is the launcher, the runner is its child),
 * and neither is a search that names one.
 */
function classifyRunner(tokens: readonly string[]): string | undefined {
  let index = tokenIndexAsProgram(tokens, (token) => runnerScript(token) !== undefined);
  if (index < 0) {
    const host = tokenIndexAsProgram(tokens, (token) => JS_HOSTS.has(basename(token)));
    if (host < 0 || runnerScript(tokens[host + 1] ?? "") === undefined) return undefined;
    index = host + 1;
  }
  const runner = runnerScript(tokens[index] ?? "");
  const subcommand = tokens[index + 1] ?? "";
  if (runner === "expo" && /^run:(ios|android)$/.test(subcommand)) return `expo ${subcommand}`;
  if (runner === "react-native" && /^(run|build)-(ios|android)$/.test(subcommand)) {
    return `react-native ${subcommand}`;
  }
  if (runner === "eas" && subcommand === "build" && tokens.includes("--local")) {
    return "eas build --local";
  }
  return undefined;
}

function hasAncestorIn(
  pid: number,
  rowsByPid: ReadonlyMap<number, ProcessSampleRow>,
  pids: ReadonlySet<number>,
): boolean {
  let current = rowsByPid.get(pid)?.ppid;
  for (
    let depth = 0;
    current !== undefined && current > 1 && depth < MAX_ANCESTRY_DEPTH;
    depth += 1
  ) {
    if (pids.has(current)) return true;
    current = rowsByPid.get(current)?.ppid;
  }
  return false;
}

export function scanNativeBuilds(input: {
  rows: readonly ProcessSampleRow[];
  agentTrees: readonly AgentProcessTree[];
}): NativeBuildScan {
  const rowsByPid = new Map(input.rows.map((row) => [row.pid, row]));
  const agentByPid = new Map<number, string>();
  for (const tree of input.agentTrees) {
    for (const pid of tree.pids) agentByPid.set(pid, tree.agentId);
  }
  const build = (pid: number, command: string): RunningNativeBuild => {
    const agentId = agentByPid.get(pid);
    return {
      pid,
      command,
      etime: rowsByPid.get(pid)?.etime ?? "",
      ...(agentId ? { agentId } : {}),
    };
  };

  const roots = new Map<number, string>();
  const runnerRoots = new Map<number, string>();
  const compileJobs: ProcessSampleRow[] = [];
  for (const row of input.rows) {
    const tokens = tokenizeProcessRow(row);
    const command = classifyBuildRoot(tokens);
    if (command) {
      roots.set(row.pid, command);
      continue;
    }
    const runner = classifyRunner(tokens);
    if (runner) runnerRoots.set(row.pid, runner);
    else if (isCompileJob(tokens)) compileJobs.push(row);
  }

  const rootPids = new Set(roots.keys());
  const builds = [...roots]
    .filter(([pid]) => !hasAncestorIn(pid, rowsByPid, rootPids))
    .map(([pid, command]) => build(pid, command));

  const services = new Set<number>();
  for (const job of compileJobs) {
    if (rootPids.has(job.ppid) || hasAncestorIn(job.pid, rowsByPid, rootPids)) continue;
    services.add(job.ppid);
  }
  for (const pid of services) {
    const service = rowsByPid.get(pid);
    const name = service ? basename(tokenizeProcessRow(service)[0] ?? "") : "";
    builds.push(build(pid, name ? `swift-frontend under ${name}` : "swift-frontend"));
  }

  const buildPids = builds.map((entry) => entry.pid);
  const runners = [...runnerRoots].map(([pid, command]): RunningBuildRunner => {
    const under = new Set([pid]);
    const building = buildPids.some((buildPid) => hasAncestorIn(buildPid, rowsByPid, under));
    return Object.assign(build(pid, command), { building });
  });
  return { builds, runners };
}
