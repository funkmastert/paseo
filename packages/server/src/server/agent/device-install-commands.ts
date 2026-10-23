/**
 * Recognizes a shell command that installs, uninstalls, or launches on a device that already
 * exists — the commands device-launch-commands.ts deliberately excludes, because they cost no
 * slot. They cost something else: run one against a physical device another agent is using and
 * it overwrites that agent's install. This is the other half of the physical-device gate
 * (docs/device-leases.md, Physical devices) — device-launch-commands.ts still owns booting a
 * simulator or emulator.
 *
 * Same discipline as device-launch-commands.ts: match a whole argv token, only when it is the
 * command actually being run. Read-only commands (`adb devices`, `adb logcat`, screenshots) are
 * not matched at all — they never touch an install.
 */

import {
  basename,
  stripCommandPrefixes,
  tokenizeCommandSegments,
} from "./device-launch-commands.js";

export type InstallCommandPlatform = "ios" | "android" | "unknown";

export interface InstallCommandIntent {
  platform: InstallCommandPlatform;
  command: string;
  /** The serial, UDID, CoreDevice identifier or device name the command names, if it names one. */
  target?: string;
  /**
   * True when the command named `simctl`'s `booted` keyword instead of a literal device.
   * `booted` is never a real simulator's name — it resolves dynamically against whatever is
   * currently booted, which can be zero, one, or more simulators, so `target` is left unset
   * rather than set to the literal string "booted". The caller resolves this the same way it
   * resolves an untargeted command, but only against currently-running devices.
   */
  bootedAlias?: boolean;
  /**
   * True when `target` still contains shell syntax this gate couldn't expand — `$(...)`, a
   * backtick, or a `$VAR`/`${VAR}` with no assignment seen earlier in the same command. The
   * command still names exactly one real device; it just isn't the literal string in `target`.
   * The caller must not read it as "names a device nothing is connected as" (that fallback is
   * for a device genuinely not connected — an emulator, a simulator, a typo) and must not grant
   * the untargeted-plain-`adb` exemption either: `-s $X` already told adb which device to pick,
   * even though this gate can't read which one.
   */
  targetUnresolved?: boolean;
  /**
   * True for a shape that installs on every connected device of its platform when no target is
   * given (`./gradlew installDebug` with no `ANDROID_SERIAL`) — untargeted is the dangerous
   * case the gate has to catch, not just the one where a device is named explicitly.
   */
  installsOnAllIfUntargeted: boolean;
  /**
   * True for a command that changes app state without installing anything (`am force-stop`).
   * It is refused only on a device another agent holds, and never takes a lease itself.
   */
  stateOnly: boolean;
}

const RUNNERS = new Set(["npx", "bunx", "pnpm", "yarn", "bun"]);

const VARIABLE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const VARIABLE_REFERENCE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** Any `$` or backtick left in a resolved target is shell syntax this gate can't read: a
 * `$(...)` subshell, a backtick substitution, `$1`/`$@`, a `${VAR:-default}` expansion, or a
 * plain `$VAR` with no assignment seen earlier in this command. `{}` is `xargs -I{}`'s default
 * replace-string — the only part of its pipeline that could plausibly land exactly on a
 * `-s`/`--device` target, standing in for whatever its stdin actually contains. A literal
 * serial, UDID or device name never looks like any of this. */
const UNEXPANDED_SHELL_SYNTAX = /[$`]|^\{\}$/;
/** Keywords that only decorate an assignment — `export S=...`, `declare -r S=...`, `local`,
 * `readonly` — never the assignment itself. Skipped so the scan below still finds the
 * `NAME=value` token after them. */
const ASSIGNMENT_PREFIX_KEYWORDS = new Set(["export", "declare", "local", "readonly"]);

/**
 * `S=FAKESERIAL001; ...; adb -s $S install app.apk` — an agent's own shell resolves `$S` to the
 * real serial before running adb; this gate's matchers only see the command's text, so without
 * resolving it too they'd read the target as the literal, never-connected device named `$S`.
 * Collected across every segment of the same command line, in order, so a later assignment
 * overrides an earlier one the way a real shell would.
 */
function collectVariableAssignments(
  segments: readonly (readonly string[])[],
): ReadonlyMap<string, string> {
  const vars = new Map<string, string>();
  for (const segment of segments) {
    for (const token of segment) {
      if (ASSIGNMENT_PREFIX_KEYWORDS.has(token)) continue;
      const match = VARIABLE_ASSIGNMENT.exec(token);
      if (!match) break;
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

/** Resolves a bare `$VAR`/`${VAR}` target against assignments made earlier in the same command
 * line, leaving it as-is when it can't be resolved there — a `$(...)`, a backtick, or a variable
 * this gate never saw assigned (exported in the agent's shell profile, or set in an earlier,
 * separate tool call). */
function resolveVariableTarget(target: string, vars: ReadonlyMap<string, string>): string {
  const match = VARIABLE_REFERENCE.exec(target);
  if (!match) return target;
  return vars.get(match[1]) ?? target;
}

/**
 * Resolves a matched intent's target against same-command variable assignments and marks it
 * `targetUnresolved` when shell syntax survives resolution — fail closed, not "nothing to
 * protect": the command still names exactly one real device, this gate just can't read which.
 */
function resolveIntentTarget(
  candidate: InstallCommandIntent,
  vars: ReadonlyMap<string, string>,
): InstallCommandIntent {
  if (!candidate.target) return candidate;
  const resolved = resolveVariableTarget(candidate.target, vars);
  if (UNEXPANDED_SHELL_SYNTAX.test(resolved)) {
    return { ...candidate, target: resolved, targetUnresolved: true };
  }
  return resolved === candidate.target ? candidate : { ...candidate, target: resolved };
}

function readFlagValue(tokens: readonly string[], ...flags: string[]): string | undefined {
  for (const flag of flags) {
    const index = tokens.indexOf(flag);
    const value = index >= 0 ? tokens[index + 1] : undefined;
    if (value && !value.startsWith("-")) return value;
    const inline = tokens.find((token) => token.startsWith(`${flag}=`));
    if (inline && inline.length > flag.length + 1) return inline.slice(flag.length + 1);
  }
  return undefined;
}

function intent(
  fields: Omit<InstallCommandIntent, "installsOnAllIfUntargeted" | "stateOnly"> &
    Partial<Pick<InstallCommandIntent, "installsOnAllIfUntargeted" | "stateOnly">>,
): InstallCommandIntent {
  const { target, ...rest } = fields;
  return {
    ...rest,
    ...(target ? { target } : {}),
    installsOnAllIfUntargeted: fields.installsOnAllIfUntargeted ?? false,
    stateOnly: fields.stateOnly ?? false,
  };
}

/** `ANDROID_SERIAL=<value>` among the leading env assignments, if the caller set one — the only
 * way to target `./gradlew install*`, and one of two ways to target a bare `adb` command. */
function readAndroidSerialEnv(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (token.startsWith("ANDROID_SERIAL=")) return token.slice("ANDROID_SERIAL=".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
  }
  return undefined;
}

/** `adb shell am|pm|cmd …` subcommands that install, uninstall, wipe or launch. Everything else
 * under `adb shell` — `pm list`, `pm path`, `am broadcast`, `getprop`, `screencap` — reads, or
 * at least leaves the installed app alone, and is never gated. */
const ADB_SHELL_INSTALL_LIKE: Readonly<Record<string, readonly string[]>> = {
  am: ["start", "start-activity"],
  pm: ["clear", "install", "uninstall"],
};

/** `adb [-s <serial>] install|install-multiple|uninstall|shell am start|shell pm clear|install`,
 * and `shell am force-stop` as a state-only change. */
function matchAdb(tokens: readonly string[]): InstallCommandIntent | undefined {
  const envSerial = readAndroidSerialEnv(tokens);
  const stripped = stripCommandPrefixes(tokens);
  if (basename(stripped[0] ?? "") !== "adb") return undefined;
  const flagSerial = readFlagValue(stripped, "-s");
  const rest = flagSerial ? stripped.slice(stripped.indexOf("-s") + 2) : stripped.slice(1);
  const sub = rest[0];
  const target = flagSerial ?? envSerial;

  // A bare `adb install` with more than one device attached refuses itself ("more than one
  // device/emulator"), so it cannot silently overwrite a second device; the manager allows it
  // in that case rather than second-guess an ANDROID_SERIAL it cannot see.
  if (sub && ["install", "install-multiple", "install-multiple-split", "uninstall"].includes(sub)) {
    return intent({ platform: "android", command: `adb ${sub}`, target });
  }
  if (sub !== "shell") return undefined;
  const tool = rest[1];
  const action = rest[2];
  if (!tool || !action) return undefined;
  if (ADB_SHELL_INSTALL_LIKE[tool]?.includes(action)) {
    return intent({ platform: "android", command: `adb shell ${tool} ${action}`, target });
  }
  if (tool === "am" && action === "force-stop") {
    return intent({
      platform: "android",
      command: "adb shell am force-stop",
      target,
      stateOnly: true,
    });
  }
  return undefined;
}

/** A gradle task that installs on the device(s): `installDebug`, `:app:installDebug`,
 * `app:uninstallAll`, and `connected…AndroidTest`, which installs the app and its test APK on
 * every connected device. Each project segment must end in `:` so there is only one way to split
 * a token — an optional separator made the split ambiguous, and a long non-install task like
 * `:motion-mobile-core:testDebugUnitTest` backtracked exponentially and froze the daemon. */
const GRADLE_DEVICE_TASK = /^:?(?:[\w-]+:)*(?:(?:un)?install\w*|connected\w*AndroidTest)$/i;

/** Shell interpreters an agent might use to run a `.sh` wrapper explicitly — `bash
 * android-gradle-parallel.sh installDebug` installs exactly like running the script directly, and
 * a wrapper that isn't marked executable practically forces this form. Mirrors
 * native-build-commands.ts's `SHELLS`/`shellScript` split: a shell running `-c '...'` runs an
 * inline command, not a script file, and is left unresolved here rather than guessed at. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash"]);

/** Strips a leading `sh`/`bash`/`zsh`/`dash` (and its flags) when it runs a script file rather
 * than `-c '...'`, so `bash scripts/android-gradle-parallel.sh installDebug` resolves to the same
 * program name as running the script directly. Returns the input unchanged when the first token
 * isn't a recognized shell, or when it runs `-c` (an inline command this gate doesn't parse). */
function stripShellInterpreter(tokens: readonly string[]): readonly string[] {
  if (!SHELL_INTERPRETERS.has(basename(tokens[0] ?? ""))) return tokens;
  let index = 1;
  while (tokens[index]?.startsWith("-")) {
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[index] as string)) return tokens;
    index += 1;
  }
  return tokens.slice(index);
}

/** Programs whose argv is exactly a gradle task list, run as-is against the project's
 * `gradlew` — `gradlew`/`gradle` themselves, plus the mobile repo's
 * `android-gradle-parallel.sh`, which only adds `--max-workers`/`--priority` flags in front of
 * `"$@"` before forwarding to `./gradlew`. A task an agent passes to the wrapper installs exactly
 * as it would passed to `gradlew` directly, `ANDROID_SERIAL` included. */
const GRADLE_TASK_FORWARDING_PROGRAMS = new Set([
  "gradlew",
  "gradle",
  "android-gradle-parallel.sh",
]);

/** `./gradlew install*` / `gradlew.bat install*` / `gradle install*` / `android-gradle-parallel.sh
 * install*` — installs on every connected device unless `ANDROID_SERIAL` is set. */
function matchGradleInstall(tokens: readonly string[]): InstallCommandIntent | undefined {
  const envSerial = readAndroidSerialEnv(tokens);
  const stripped = stripShellInterpreter(stripCommandPrefixes(tokens));
  const program = basename(stripped[0] ?? "");
  if (!GRADLE_TASK_FORWARDING_PROGRAMS.has(program)) return undefined;
  const task = stripped.slice(1).find((token) => GRADLE_DEVICE_TASK.test(token));
  if (!task) return undefined;
  return intent({
    platform: "android",
    command: `${program} ${task}`,
    target: envSerial,
    installsOnAllIfUntargeted: true,
  });
}

/** `expo run:android --device <id>` / `expo run:ios --device <id>`. Only gated when `--device`
 * names one — without it the runner uses a simulator/emulator, which device-launch-commands.ts
 * covers. */
function matchExpoRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  const skipped = RUNNERS.has(basename(tokens[0] ?? "")) ? tokens.slice(1) : tokens;
  if (basename(skipped[0] ?? "") !== "expo") return undefined;
  const sub = skipped[1];
  let platform: "ios" | "android" | undefined;
  if (sub === "run:ios") platform = "ios";
  else if (sub === "run:android") platform = "android";
  if (!platform) return undefined;
  const target = readFlagValue(skipped, "--device", "-d");
  if (!target) return undefined;
  return intent({ platform, command: `expo ${sub} --device`, target });
}

/** `react-native run-android --deviceId <id>` / `run-ios --udid <id>` / `run-ios --device
 * <name>`. Same reasoning as expo run: only gated when the flag names a device. */
function matchReactNativeRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  const skipped = RUNNERS.has(basename(tokens[0] ?? "")) ? tokens.slice(1) : tokens;
  if (basename(skipped[0] ?? "") !== "react-native") return undefined;
  const sub = skipped[1];
  if (sub === "run-android") {
    const target = readFlagValue(skipped, "--deviceId");
    return target
      ? intent({ platform: "android", command: "react-native run-android --deviceId", target })
      : undefined;
  }
  if (sub === "run-ios") {
    const target = readFlagValue(skipped, "--udid", "--device");
    return target
      ? intent({ platform: "ios", command: "react-native run-ios --udid", target })
      : undefined;
  }
  return undefined;
}

/**
 * Repo wrapper scripts that take a device flag and install straight onto it — not a recognized
 * CLI like `expo`/`react-native`, so they need their own table entry rather than falling out of
 * an existing matcher. The mobile repo's `ios-fast-iterate.sh --device <UDID>` builds and then
 * runs `xcrun devicectl device install app --device <UDID>` itself; the hook only ever sees the
 * wrapper's own argv, never the command it shells out to. `--device` is required by the script
 * (it exits before installing without one), so there is no untargeted case to catch here, unlike
 * `matchGradleInstall`.
 */
const DEVICE_FLAG_WRAPPER_SCRIPTS: ReadonlyArray<{
  readonly scriptBasename: string;
  readonly platform: InstallCommandPlatform;
  readonly deviceFlags: readonly string[];
  /** When every one of these flags is present together, the invocation changes nothing on the
   * device — `ios-fast-iterate.sh --skip-install --skip-launch` only builds. */
  readonly noopFlags?: readonly string[];
}> = [
  {
    scriptBasename: "ios-fast-iterate.sh",
    platform: "ios",
    deviceFlags: ["--device"],
    noopFlags: ["--skip-install", "--skip-launch"],
  },
];

/** `ios-fast-iterate.sh --device <UDID>` and any other entry in `DEVICE_FLAG_WRAPPER_SCRIPTS`. */
function matchDeviceFlagWrapperScript(tokens: readonly string[]): InstallCommandIntent | undefined {
  const stripped = stripShellInterpreter(stripCommandPrefixes(tokens));
  const program = basename(stripped[0] ?? "");
  const script = DEVICE_FLAG_WRAPPER_SCRIPTS.find((entry) => entry.scriptBasename === program);
  if (!script) return undefined;
  if (script.noopFlags?.every((flag) => stripped.includes(flag))) return undefined;
  const deviceFlag = script.deviceFlags.find((flag) => stripped.includes(flag));
  if (!deviceFlag) return undefined;
  const target = readFlagValue(stripped, deviceFlag);
  if (!target) return undefined;
  return intent({ platform: script.platform, command: `${program} ${deviceFlag}`, target });
}

/** `xcrun devicectl device install app|uninstall app|process launch … --device <id>`. */
function matchDevicectl(tokens: readonly string[]): InstallCommandIntent | undefined {
  const program = basename(tokens[0] ?? "");
  const rest = program === "xcrun" ? tokens.slice(1) : tokens;
  if (basename(rest[0] ?? "") !== "devicectl" || rest[1] !== "device") return undefined;
  let action: string | undefined;
  if (rest[2] === "install" || rest[2] === "uninstall") action = rest[2];
  else if (rest[2] === "process" && rest[3] === "launch") action = "process launch";
  if (!action) return undefined;
  return intent({
    platform: "ios",
    command: `devicectl device ${action}`,
    target: readFlagValue(rest, "--device", "-d"),
  });
}

/** The xcodebuild actions that install on the destination. `build` and `archive` don't. */
const XCODEBUILD_INSTALLING_ACTIONS = new Set(["test", "test-without-building"]);

/** `xcodebuild test … -destination 'id=<udid>'` or `'platform=iOS,name=<name>'` — a physical
 * destination, not `platform=iOS Simulator…` (matched separately below, since it runs the test
 * against a SIMULATOR instead) and not `generic/platform=iOS`, which names no device at all. */
function matchXcodebuildPhysical(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "xcodebuild") return undefined;
  if (!tokens.some((token) => XCODEBUILD_INSTALLING_ACTIONS.has(token))) return undefined;
  const destination = readFlagValue(tokens, "-destination");
  if (!destination) return undefined;
  if (/generic\//i.test(destination)) return undefined;
  if (/platform\s*=\s*iOS Simulator/i.test(destination)) return undefined;
  if (!/platform\s*=\s*iOS\b/i.test(destination) && !/\bid\s*=/.test(destination)) return undefined;
  const id = /\bid\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const name = /\bname\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  return intent({ platform: "ios", command: "xcodebuild -destination", target: id ?? name });
}

/** `xcodebuild test … -destination 'platform=iOS Simulator,id=<udid>'` or `'…,name=<name>'` —
 * runs the test against a SIMULATOR that already exists (or is about to be booted:
 * device-launch-commands.ts's `matchXcodebuildDestination` covers the boot half). Running a
 * test on another agent's simulator is exactly the harm this gate exists to stop, the same as
 * installing over it. Only gated when `id`/`name` names one literally: an untargeted
 * `-destination 'platform=iOS Simulator'` (xcodebuild picks one itself) is left unmatched
 * rather than produced as a target-less intent — this shares `InstallCommandIntent` with
 * `PhysicalDeviceLeaseManager.gateInstall`, which would otherwise read a target-less iOS intent
 * as ambiguous among connected PHONES, a registry this command never touches. */
function matchXcodebuildSimulator(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "xcodebuild") return undefined;
  if (!tokens.some((token) => XCODEBUILD_INSTALLING_ACTIONS.has(token))) return undefined;
  const destination = readFlagValue(tokens, "-destination");
  if (!destination || !/platform\s*=\s*iOS Simulator/i.test(destination)) return undefined;
  const id = /\bid\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const name = /\bname\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const target = id ?? name;
  return target
    ? intent({ platform: "ios", command: "xcodebuild -destination", target })
    : undefined;
}

/** `ios-deploy` when it installs or launches (`-b/--bundle`) or uninstalls (`-9/--uninstall_only`).
 * `--detect`, `--list`, `--exists` and the other inspection flags never touch the install. */
function matchIosDeploy(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "ios-deploy") return undefined;
  const changesInstall = tokens.some((token) =>
    ["-b", "--bundle", "-9", "--uninstall_only"].includes(token),
  );
  if (!changesInstall) return undefined;
  return intent({
    platform: "ios",
    command: "ios-deploy",
    target: readFlagValue(tokens, "--id", "-i"),
  });
}

/** `simctl`'s install-like subcommands — the only ones that change a simulator's app state.
 * `boot`/`shutdown` are device-launch-commands.ts's and device-lease-manager.ts's territory
 * (booting/stopping the device itself, not an app on it); `erase` wipes the whole device rather
 * than one app's install, and `list` only reads. None of those four are matched here. */
const SIMCTL_INSTALL_LIKE = new Set(["install", "uninstall", "launch", "terminate"]);

/** `simctl launch` flags that take their value as a separate following token (`--stdout <path>`),
 * rather than attached (`--stdout=<path>`) — only the separate form has an extra token to skip
 * past. The no-value flags (`--console`, `--console-pty`, `-w`/`--wait-for-debugger`,
 * `--terminate-running-process`) and the attached-value form are both handled by the generic
 * "starts with -" skip below. */
const SIMCTL_SEPARATE_VALUE_FLAGS = new Set(["--stdout", "--stderr"]);

/** The device/`booted` argument after `simctl`'s subcommand, skipping any flags in between —
 * `simctl launch` takes real flags before the device (`--console`, `-w`, `--stdout=…`), and a
 * fixed-position read would capture one of those as the target instead. The device argument is
 * never flag-shaped, so any `-`-prefixed token encountered first is a flag to skip, not the
 * target. */
function findSimctlTarget(tokens: readonly string[]): string | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (!token.startsWith("-")) return token;
    index += SIMCTL_SEPARATE_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return undefined;
}

/** `xcrun simctl install|uninstall|launch|terminate <udid|name|booted> ...`. `booted` is a
 * resolution keyword, not a literal device (see `InstallCommandIntent.bootedAlias`). */
function matchSimctl(tokens: readonly string[]): InstallCommandIntent | undefined {
  const program = basename(tokens[0] ?? "");
  const rest = program === "xcrun" ? tokens.slice(1) : tokens;
  if (basename(rest[0] ?? "") !== "simctl") return undefined;
  const sub = rest[1];
  if (!sub || !SIMCTL_INSTALL_LIKE.has(sub)) return undefined;
  const positional = findSimctlTarget(rest.slice(2));
  if (positional === "booted") {
    return intent({ platform: "ios", command: `simctl ${sub}`, bootedAlias: true });
  }
  return intent({ platform: "ios", command: `simctl ${sub}`, target: positional });
}

/** `flutter run -d <id>`. Flutter's device id can name either platform's device, so the caller
 * resolves it against both. */
function matchFlutterRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "flutter") return undefined;
  if (tokens[1] !== "run") return undefined;
  const target = readFlagValue(tokens, "-d", "--device-id");
  if (!target) return undefined;
  return intent({ platform: "unknown", command: "flutter run -d", target });
}

const MATCHERS = [
  matchAdb,
  matchGradleInstall,
  matchExpoRun,
  matchReactNativeRun,
  matchDeviceFlagWrapperScript,
  matchDevicectl,
  matchXcodebuildPhysical,
  matchXcodebuildSimulator,
  matchIosDeploy,
  matchSimctl,
  matchFlutterRun,
];

/** Every install-affecting command in a single shell command line — segmented the same way
 * device-launch-commands.ts is, so `cmd1 && cmd2` is gated per segment. */
export function detectInstallCommandIntents(command: string): InstallCommandIntent[] {
  const intents: InstallCommandIntent[] = [];
  const segments = tokenizeCommandSegments(command);
  const vars = collectVariableAssignments(segments);
  for (const segment of segments) {
    if (segment.length === 0) continue;
    for (const matcher of MATCHERS) {
      const match = matcher(segment);
      if (match) {
        intents.push(resolveIntentTarget(match, vars));
        break;
      }
    }
  }
  return intents;
}
