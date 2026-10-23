/**
 * The allowlist of build daemons the resource monitor knows how to recognise: which command lines
 * are a Gradle daemon, a Kotlin compile daemon, a .NET compiler or build server, or Metro. Shared
 * by process-attribution.ts (which counts them as orphan build daemons) and
 * build-daemon-reaper.ts (which signals the abandoned ones). See docs/resource-monitor.md.
 *
 * Every matcher works on whole argv tokens, never substrings: `grep GradleDaemon`, an editor with
 * the string in a path, and the reaper's own source all contain the names below. Each matcher also
 * needs a second fact that a search or an editor can't fake — a `java` token before a main class,
 * a `dotnet` host before a dll, a pipe argument after an apphost, a node token before a CLI script.
 *
 * `ps` gives one space-joined string, and the paths involved (`Android Studio.app`, `Program
 * Files`) contain spaces, so nothing here reads argv[0]: it looks at path basenames per token,
 * which survives a path being split across tokens. Separators and `.exe` names for Windows are
 * accepted so the matchers stay right if Windows reaping ever arrives; the reaper itself is
 * POSIX-only because it needs a uid to prove the process is the daemon's own.
 */

export type ReapableBuildDaemonKind =
  | "gradle"
  | "kotlin"
  | "vbcscompiler"
  | "msbuild-node"
  | "razor-server"
  | "metro";

export interface BuildDaemonSignature {
  kind: ReapableBuildDaemonKind;
  label: string;
}

/**
 * Names that mark a process as a build daemon even when no matcher accepts its full command
 * line. process-attribution.ts has always counted by these substrings; the reaper uses them to
 * report a ppid-1 process it rejected as `not-on-allowlist`. Only names that are unambiguous on
 * their own belong here: Metro, MSBuild and the Razor server are counted by exact match only.
 */
const ORPHAN_BUILD_DAEMON_MARKERS = [
  "GradleDaemon",
  "KotlinCompileDaemon",
  "VBCSCompiler",
] as const;

function baseName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? "").toLowerCase();
}

function hasPathSeparator(token: string): boolean {
  return /[\\/]/.test(token);
}

function isDotnetHost(token: string): boolean {
  const name = baseName(token);
  return name === "dotnet" || name === "dotnet.exe";
}

function isNodeExecutable(token: string): boolean {
  const name = baseName(token);
  return name === "node" || name === "node.exe" || name === "nodejs";
}

function isJavaExecutable(token: string): boolean {
  const name = baseName(token);
  return name === "java" || name === "java.exe";
}

function hasDotnetHostBefore(tokens: readonly string[], index: number): boolean {
  return tokens.slice(0, index).some(isDotnetHost);
}

/**
 * JVM daemons are launched as `.../bin/java <opts> <mainClass>`. Verified against a live Gradle
 * 9.7.1 daemon (`org.gradle.launcher.daemon.bootstrap.GradleDaemon` is the last token of its
 * command line) and a live Kotlin 2.4.20 daemon started by that Gradle (`java -cp <jars>
 * org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-...`). Without the `java` token,
 * `grep -r org.gradle...GradleDaemon .` would pass the whole-token test.
 */
function jvmMainClassMatcher(mainClass: string): (tokens: readonly string[]) => boolean {
  return (tokens) => {
    const mainClassIndex = tokens.indexOf(mainClass);
    return mainClassIndex > 0 && tokens.slice(0, mainClassIndex).some(isJavaExecutable);
  };
}

/**
 * Roslyn's compiler server, started by the compiler client as
 * `<sdk>/Roslyn/bincore/VBCSCompiler -pipename:<hash>` (the apphost — observed live) or under the
 * host as `dotnet .../VBCSCompiler.dll -pipename:<hash>` (derived from the SDK layout, which
 * ships both files). The pipe argument is what a grep or an editor holding the path lacks.
 */
function matchesRoslynServer(tokens: readonly string[]): boolean {
  const index = tokens.findIndex((token) => {
    const name = baseName(token);
    return (
      hasPathSeparator(token) &&
      (name === "vbcscompiler" || name === "vbcscompiler.exe" || name === "vbcscompiler.dll")
    );
  });
  if (index < 0) return false;
  if (baseName(tokens[index] as string).endsWith(".dll") && !hasDotnetHostBefore(tokens, index)) {
    return false;
  }
  return tokens.slice(index + 1).some((token) => /^[-/]pipename:./i.test(token));
}

/**
 * An MSBuild node-reuse worker: `dotnet <sdk>/MSBuild.dll /noautoresponse /nologo /nodemode:1
 * /nodeReuse:true /low:false` (observed live, fifteen of them). The `/nodemode:` argument marks
 * a worker rather than the `dotnet build` client, and `/nodeReuse:true` marks one that outlives
 * its build; a worker started with reuse off exits on its own.
 */
function matchesMsbuildNode(tokens: readonly string[]): boolean {
  const index = tokens.findIndex((token) => {
    const name = baseName(token);
    return name === "msbuild.dll" || name === "msbuild.exe";
  });
  if (index < 0) return false;
  if (baseName(tokens[index] as string) === "msbuild.dll" && !hasDotnetHostBefore(tokens, index)) {
    return false;
  }
  const rest = tokens.slice(index + 1);
  return (
    rest.some((token) => /^[-/]{1,2}nodemode:\d+$/i.test(token)) &&
    rest.some((token) => /^[-/]{1,2}nodereuse:true$/i.test(token))
  );
}

/**
 * The Razor build server: `dotnet <sdk>/Sdks/Microsoft.NET.Sdk.Razor/tools/rzc.dll server -p
 * <pipe>`. Derived, not observed — no server was running when this was written. The SDK's
 * `rzc.dll` has a `server` command taking `-p|--pipe`, and the Razor tasks launch it through
 * `dotnet` (`dotnet.exe` on Windows). `rzc.dll generate` and friends are one-shot compiles and
 * don't match.
 */
function matchesRazorServer(tokens: readonly string[]): boolean {
  const index = tokens.findIndex((token) => baseName(token) === "rzc.dll");
  return (
    index > 0 &&
    hasDotnetHostBefore(tokens, index) &&
    (tokens[index + 1] ?? "").toLowerCase() === "server"
  );
}

interface MetroLauncher {
  /** Normalised (lower-case, forward-slash) suffixes of the CLI script node is running. */
  scriptSuffixes: readonly string[];
  /** The subcommand right after the script that starts the bundler. */
  subcommand: string;
}

/**
 * Metro has no process of its own: `expo start` and `react-native start` run it inside the node
 * process that runs the CLI. `expo/bin/cli` only `require`s @expo/cli, so that process's argv is
 * the bin shim (`node_modules/.bin/expo`, what npm and npx exec) or the file it points at. Derived
 * from the package layouts in this repo's node_modules; no Metro was running on this machine.
 * A wrapper such as `cross-env ... expo start` or `npm run start` has a different script token
 * and is rejected, so only the process that is the bundler matches.
 */
const METRO_LAUNCHERS: readonly MetroLauncher[] = [
  { scriptSuffixes: ["/.bin/expo", "/expo/bin/cli", "/expo/bin/cli.js"], subcommand: "start" },
  {
    scriptSuffixes: ["/.bin/react-native", "/react-native/cli.js"],
    subcommand: "start",
  },
  { scriptSuffixes: ["/.bin/metro", "/metro/src/cli.js"], subcommand: "serve" },
];

function matchesMetro(tokens: readonly string[]): boolean {
  const nodeIndex = tokens.findIndex(isNodeExecutable);
  if (nodeIndex < 0) return false;
  // The script is the first non-flag argument to node. A script path split by a space in its
  // directory name lands on a fragment and is rejected — the safe direction to fail.
  let scriptIndex = nodeIndex + 1;
  while (scriptIndex < tokens.length && (tokens[scriptIndex] as string).startsWith("-")) {
    scriptIndex += 1;
  }
  const script = (tokens[scriptIndex] ?? "").replace(/\\/g, "/").toLowerCase();
  const subcommand = (tokens[scriptIndex + 1] ?? "").toLowerCase();
  return METRO_LAUNCHERS.some(
    (launcher) =>
      launcher.subcommand === subcommand &&
      launcher.scriptSuffixes.some((suffix) => script.endsWith(suffix)),
  );
}

interface BuildDaemonRule extends BuildDaemonSignature {
  matches: (tokens: readonly string[]) => boolean;
}

/**
 * The allowlist. Nothing outside it is ever signalled — everything else the monitor finds is
 * reported exactly as before. Adding an entry means verifying the process's real command line
 * first, not guessing at a plausible marker.
 */
const BUILD_DAEMON_RULES: readonly BuildDaemonRule[] = [
  {
    kind: "gradle",
    label: "Gradle daemon",
    matches: jvmMainClassMatcher("org.gradle.launcher.daemon.bootstrap.GradleDaemon"),
  },
  {
    kind: "kotlin",
    label: "Kotlin compile daemon",
    matches: jvmMainClassMatcher("org.jetbrains.kotlin.daemon.KotlinCompileDaemon"),
  },
  {
    kind: "vbcscompiler",
    label: ".NET compiler server (VBCSCompiler)",
    matches: matchesRoslynServer,
  },
  { kind: "msbuild-node", label: "MSBuild node", matches: matchesMsbuildNode },
  { kind: "razor-server", label: "Razor build server", matches: matchesRazorServer },
  { kind: "metro", label: "Metro bundler", matches: matchesMetro },
];

export function matchBuildDaemonSignature(command: string): BuildDaemonSignature | undefined {
  const tokens = command.split(/\s+/);
  const rule = BUILD_DAEMON_RULES.find((candidate) => candidate.matches(tokens));
  return rule ? { kind: rule.kind, label: rule.label } : undefined;
}

/**
 * Whether a ppid-1 process counts as an orphan build daemon: an exact allowlist match, or one of
 * the unambiguous names above.
 */
export function isOrphanBuildDaemonCommand(command: string): boolean {
  return (
    matchBuildDaemonSignature(command) !== undefined ||
    ORPHAN_BUILD_DAEMON_MARKERS.some((marker) => command.includes(marker))
  );
}
