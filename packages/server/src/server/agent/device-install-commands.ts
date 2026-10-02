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

/** `./gradlew install*` / `gradlew.bat install*` / `gradle install*` — installs on every
 * connected device unless `ANDROID_SERIAL` is set. */
function matchGradleInstall(tokens: readonly string[]): InstallCommandIntent | undefined {
  const envSerial = readAndroidSerialEnv(tokens);
  const stripped = stripCommandPrefixes(tokens);
  const program = basename(stripped[0] ?? "");
  if (program !== "gradlew" && program !== "gradle") return undefined;
  const task = stripped.slice(1).find((token) => GRADLE_DEVICE_TASK.test(token));
  if (!task) return undefined;
  return intent({
    platform: "android",
    command: `gradlew ${task}`,
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
 * destination, not `platform=iOS Simulator…` (device-launch-commands.ts's territory) and not
 * `generic/platform=iOS`, which names no device at all. */
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
  matchDevicectl,
  matchXcodebuildPhysical,
  matchIosDeploy,
  matchFlutterRun,
];

/** Every install-affecting command in a single shell command line — segmented the same way
 * device-launch-commands.ts is, so `cmd1 && cmd2` is gated per segment. */
export function detectInstallCommandIntents(command: string): InstallCommandIntent[] {
  const intents: InstallCommandIntent[] = [];
  for (const segment of tokenizeCommandSegments(command)) {
    if (segment.length === 0) continue;
    for (const matcher of MATCHERS) {
      const match = matcher(segment);
      if (match) {
        intents.push(match);
        break;
      }
    }
  }
  return intents;
}
