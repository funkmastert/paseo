/**
 * Recognizes a shell command that boots an iOS simulator or an Android emulator, so the launch
 * gate can decide before the device exists. Pure and deliberately narrow.
 *
 * The discipline is build-daemon-reaper.ts's: match a whole argv token, and only when it is the
 * command being run rather than a string that happens to contain it. `grep "simctl boot" notes.md`
 * and `echo 'run emulator -avd Pixel'` must not be gated, because a false positive here blocks
 * work that would never have started a device. A false negative only means the device is caught
 * by the process scan a sweep later, which is the layer that actually enforces the count.
 *
 * Commands that *use* a device without booting one — `adb install`, `gradle installDebug`,
 * `xcrun simctl launch` — are deliberately not listed. They need a device that already exists,
 * so gating them would refuse work that costs no slot.
 */

import type { DevicePlatform } from "./device-detection.js";

export interface DeviceLaunchIntent {
  platform: DevicePlatform;
  /** The tool that would boot it, for the denial message. */
  command: string;
  /**
   * The device the command names, when it names one — a simulator UDID or name, or an AVD.
   * Lets the gate allow a boot of a device that is already running, which costs no new slot.
   */
  target?: string;
}

/**
 * Splits a command line into segments (one per `&&`, `||`, `;`, `|` or newline) and each segment
 * into argv-style tokens, honouring quotes. A naive whitespace split turns
 * `-destination 'platform=iOS Simulator,name=iPhone 17 Pro'` into six tokens and loses the
 * destination, and turns `simctl boot 'iPhone 17 Pro'` into a device named `'iPhone` — both of
 * which the gate would then misread.
 *
 * Exported for test-run-commands.ts, which classifies the same command lines for a different
 * question and must not disagree with this file about where a token ends.
 */
export function tokenizeCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;

  const endToken = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      current += command[index];
      hasToken = true;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      // `&&`, `||`, `;`, `|` and a trailing `&` all end the command being built.
      endSegment();
      continue;
    }
    if (/\s/.test(char)) {
      endToken();
      continue;
    }
    current += char;
    hasToken = true;
  }
  endSegment();
  return segments;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SIMULATOR_UDID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

function basename(token: string): string {
  return token.split("/").pop() ?? token;
}

/**
 * The tokens of one command, with leading `env`/`VAR=value`/`sudo`/`time` prefixes stripped so
 * the first token is the program being run.
 */
export function stripCommandPrefixes(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (ENV_ASSIGNMENT.test(token) || ["env", "sudo", "time", "nohup", "exec"].includes(token)) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function readFlagValue(tokens: readonly string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  const value = index >= 0 ? tokens[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

/** `xcrun simctl boot <device>` and the bare `simctl boot <device>`. */
function matchSimctlBoot(tokens: readonly string[]): DeviceLaunchIntent | undefined {
  const program = basename(tokens[0] ?? "");
  const rest = program === "xcrun" ? tokens.slice(1) : tokens;
  if (basename(rest[0] ?? "") !== "simctl" || rest[1] !== "boot") return undefined;
  const target = rest[2];
  return { platform: "ios", command: "xcrun simctl boot", ...(target ? { target } : {}) };
}

/**
 * `xcodebuild -destination 'platform=iOS Simulator,...'` boots the simulator it targets if it
 * is not already running, which is the most common way a device appears without anybody asking
 * for one. A destination naming a real device or `platform=macOS` boots nothing.
 */
function matchXcodebuildDestination(tokens: readonly string[]): DeviceLaunchIntent | undefined {
  if (basename(tokens[0] ?? "") !== "xcodebuild") return undefined;
  const destination = readFlagValue(tokens, "-destination");
  if (!destination || !/platform\s*=\s*iOS Simulator/i.test(destination)) return undefined;
  const id = /\bid\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const name = /\bname\s*=\s*([^,]+)/i.exec(destination)?.[1]?.trim();
  const target = id ?? name;
  return { platform: "ios", command: "xcodebuild -destination", ...(target ? { target } : {}) };
}

/** `open -a Simulator` boots whichever device was last used. */
function matchOpenSimulator(tokens: readonly string[]): DeviceLaunchIntent | undefined {
  if (basename(tokens[0] ?? "") !== "open") return undefined;
  const app = readFlagValue(tokens, "-a");
  return app && /^simulator(\.app)?$/i.test(app)
    ? { platform: "ios", command: "open -a Simulator" }
    : undefined;
}

/** `emulator -avd <name>` and its `emulator @<name>` shorthand. */
function matchEmulator(tokens: readonly string[]): DeviceLaunchIntent | undefined {
  const program = basename(tokens[0] ?? "");
  if (program !== "emulator" && !program.startsWith("qemu-system-")) return undefined;
  const avd = readFlagValue(tokens, "-avd");
  const shorthand = tokens
    .slice(1)
    .find((token) => token.startsWith("@"))
    ?.slice(1);
  const target = avd ?? shorthand;
  // No AVD named, no device booted: `emulator -list-avds` and `emulator -help` are inspection.
  return target ? { platform: "android", command: "emulator", target } : undefined;
}

/**
 * The cross-platform runners each boot a device when none is connected. The platform comes from
 * the subcommand, so `flutter run -d <id>` against an already-running device is still gated —
 * it may boot one when that id is not up. `target` is left unset: their device selectors are not
 * UDIDs or AVD names, so claiming a match would bind the wrong device.
 */
const RUNNER_SUBCOMMANDS: ReadonlyArray<{
  program: string;
  subcommand: RegExp;
  platform: DevicePlatform;
}> = [
  { program: "expo", subcommand: /^run:ios$/, platform: "ios" },
  { program: "expo", subcommand: /^run:android$/, platform: "android" },
  { program: "react-native", subcommand: /^run-ios$/, platform: "ios" },
  { program: "react-native", subcommand: /^run-android$/, platform: "android" },
];

function matchRunner(tokens: readonly string[]): DeviceLaunchIntent | undefined {
  // `npx expo run:ios`, `bunx expo run:ios`: skip the runner so the next token is the program.
  const skipped = ["npx", "bunx", "pnpm", "yarn", "bun"].includes(basename(tokens[0] ?? ""))
    ? tokens.slice(1)
    : tokens;
  const program = basename(skipped[0] ?? "");
  const subcommand = skipped[1] ?? "";
  const match = RUNNER_SUBCOMMANDS.find(
    (entry) => entry.program === program && entry.subcommand.test(subcommand),
  );
  return match ? { platform: match.platform, command: `${program} ${subcommand}` } : undefined;
}

const MATCHERS = [
  matchSimctlBoot,
  matchXcodebuildDestination,
  matchOpenSimulator,
  matchEmulator,
  matchRunner,
];

/**
 * Every device a single shell command would boot. A command can boot more than one — CI-style
 * one-liners chain a simulator boot and an emulator start with `&&` — so each segment is
 * classified on its own and the gate has to find room for all of them.
 */
export function detectDeviceLaunchIntents(command: string): DeviceLaunchIntent[] {
  const intents: DeviceLaunchIntent[] = [];
  for (const segment of tokenizeCommandSegments(command)) {
    const tokens = stripCommandPrefixes(segment);
    if (tokens.length === 0) continue;
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

/** Whether a launch intent's `target` names the device a `ps` scan found, so no slot is needed. */
export function targetMatchesRunningDevice(
  target: string | undefined,
  device: { platform: DevicePlatform; deviceId: string },
  platform: DevicePlatform,
): boolean {
  if (!target || device.platform !== platform) return false;
  if (SIMULATOR_UDID.test(target)) return device.deviceId.toUpperCase() === target.toUpperCase();
  return device.deviceId === target;
}
