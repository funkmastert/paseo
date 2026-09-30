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

import { stripCommandPrefixes, tokenizeCommandSegments } from "./device-launch-commands.js";

export type InstallCommandPlatform = "ios" | "android" | "unknown";

export interface InstallCommandIntent {
  platform: InstallCommandPlatform;
  command: string;
  /** The serial, UDID, or device name the command names, when it names one. */
  target?: string;
  /**
   * True for a shape that installs on every connected device of its platform when no target is
   * given (`./gradlew installDebug` with no `ANDROID_SERIAL`) — untargeted is the dangerous
   * case the gate has to catch, not just the one where a device is named explicitly.
   */
  installsOnAllIfUntargeted: boolean;
}

function basename(token: string): string {
  return token.split("/").pop() ?? token;
}

function readFlagValue(tokens: readonly string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  const value = index >= 0 ? tokens[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
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

/** `adb [-s <serial>] install|install-multiple|uninstall|shell am start|shell pm clear`. */
function matchAdb(tokens: readonly string[]): InstallCommandIntent | undefined {
  const envSerial = readAndroidSerialEnv(tokens);
  const stripped = stripCommandPrefixes(tokens);
  if (basename(stripped[0] ?? "") !== "adb") return undefined;
  const flagSerial = readFlagValue(stripped, "-s");
  const rest = flagSerial ? stripped.slice(stripped.indexOf("-s") + 2) : stripped.slice(1);
  const sub = rest[0];

  const installLike = sub && ["install", "install-multiple", "uninstall"].includes(sub);
  const shellLike =
    sub === "shell" && rest[1] && ["am", "pm"].includes(rest[1]) && rest[2] !== undefined;
  if (!installLike && !shellLike) return undefined;

  const command = shellLike ? `adb shell ${rest[1]} ${rest[2]}` : `adb ${sub}`;
  const target = flagSerial ?? envSerial;
  return {
    platform: "android",
    command,
    ...(target ? { target } : {}),
    // A bare `adb install` with no -s and multiple devices attached installs on whichever one
    // adb picks when there's exactly one, and refuses itself ("more than one device/emulator")
    // when there's more than one — so it cannot silently overwrite a second device. Still
    // dangerous with exactly one OTHER agent's device attached and this agent meaning its own.
    installsOnAllIfUntargeted: false,
  };
}

/** `./gradlew install*` / `gradlew.bat install*` — installs on every connected device unless
 * `ANDROID_SERIAL` is set. */
function matchGradleInstall(tokens: readonly string[]): InstallCommandIntent | undefined {
  const envSerial = readAndroidSerialEnv(tokens);
  const stripped = stripCommandPrefixes(tokens);
  const program = basename(stripped[0] ?? "");
  if (!/^gradlew(\.bat)?$/.test(program)) return undefined;
  const task = stripped.find((token) => /^install\w*$/i.test(token));
  if (!task) return undefined;
  return {
    platform: "android",
    command: `gradlew ${task}`,
    ...(envSerial ? { target: envSerial } : {}),
    installsOnAllIfUntargeted: true,
  };
}

/** `expo run:android --device <id>` / `expo run:ios --device <id>`. Only gated when `--device`
 * actually names one — without it these boot a simulator/emulator, which
 * device-launch-commands.ts already covers. */
function matchExpoRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  const skipped = ["npx", "bunx", "pnpm", "yarn", "bun"].includes(basename(tokens[0] ?? ""))
    ? tokens.slice(1)
    : tokens;
  if (basename(skipped[0] ?? "") !== "expo") return undefined;
  const sub = skipped[1];
  let platform: "ios" | "android" | undefined;
  if (sub === "run:ios") platform = "ios";
  else if (sub === "run:android") platform = "android";
  if (!platform) return undefined;
  const target = readFlagValue(skipped, "--device");
  if (!target) return undefined;
  return { platform, command: `expo ${sub} --device`, target, installsOnAllIfUntargeted: false };
}

/** `react-native run-android --deviceId <id>` / `run-ios --udid <id>`. Same reasoning as expo
 * run: only gated when the flag names a device. */
function matchReactNativeRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  const skipped = ["npx", "bunx", "pnpm", "yarn", "bun"].includes(basename(tokens[0] ?? ""))
    ? tokens.slice(1)
    : tokens;
  if (basename(skipped[0] ?? "") !== "react-native") return undefined;
  const sub = skipped[1];
  if (sub === "run-android") {
    const target = readFlagValue(skipped, "--deviceId");
    return target
      ? {
          platform: "android",
          command: "react-native run-android --deviceId",
          target,
          installsOnAllIfUntargeted: false,
        }
      : undefined;
  }
  if (sub === "run-ios") {
    const target = readFlagValue(skipped, "--udid");
    return target
      ? {
          platform: "ios",
          command: "react-native run-ios --udid",
          target,
          installsOnAllIfUntargeted: false,
        }
      : undefined;
  }
  return undefined;
}

/** `xcrun devicectl device install ... --device <udid>` / `process launch ... --device <udid>`. */
function matchDevicectl(tokens: readonly string[]): InstallCommandIntent | undefined {
  const program = basename(tokens[0] ?? "");
  const rest = program === "xcrun" ? tokens.slice(1) : tokens;
  if (basename(rest[0] ?? "") !== "devicectl") return undefined;
  const isInstall = rest[1] === "device" && rest[2] === "install";
  const isLaunch = rest[1] === "process" && rest[2] === "launch";
  if (!isInstall && !isLaunch) return undefined;
  const target = readFlagValue(rest, "--device");
  return {
    platform: "ios",
    command: `devicectl ${rest[1]} ${rest[2]}`,
    ...(target ? { target } : {}),
    installsOnAllIfUntargeted: false,
  };
}

/** `xcodebuild ... -destination 'id=<udid>'` or `'platform=iOS,name=<name>'` — a physical
 * destination, not `platform=iOS Simulator…` (device-launch-commands.ts's territory). */
function matchXcodebuildPhysical(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "xcodebuild") return undefined;
  const destination = readFlagValue(tokens, "-destination");
  if (!destination) return undefined;
  if (/platform\s*=\s*iOS Simulator/i.test(destination)) return undefined;
  if (!/platform\s*=\s*iOS\b/i.test(destination) && !/\bid\s*=/.test(destination)) return undefined;
  const id = /\bid\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const name = /\bname\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const target = id ?? name;
  return {
    platform: "ios",
    command: "xcodebuild -destination",
    ...(target ? { target } : {}),
    installsOnAllIfUntargeted: false,
  };
}

/** `ios-deploy --id <udid>`. */
function matchIosDeploy(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "ios-deploy") return undefined;
  const target = readFlagValue(tokens, "--id");
  return {
    platform: "ios",
    command: "ios-deploy",
    ...(target ? { target } : {}),
    installsOnAllIfUntargeted: false,
  };
}

/** `flutter run -d <id>`. Flutter's device id can name either platform's device, so the caller
 * resolves it against both. */
function matchFlutterRun(tokens: readonly string[]): InstallCommandIntent | undefined {
  if (basename(tokens[0] ?? "") !== "flutter") return undefined;
  if (tokens[1] !== "run") return undefined;
  const target = readFlagValue(tokens, "-d") ?? readFlagValue(tokens, "--device-id");
  if (!target) return undefined;
  return {
    platform: "unknown",
    command: "flutter run -d",
    target,
    installsOnAllIfUntargeted: false,
  };
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
      const intent = matcher(segment);
      if (intent) {
        intents.push(intent);
        break;
      }
    }
  }
  return intents;
}
