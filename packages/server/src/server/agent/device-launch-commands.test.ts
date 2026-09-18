import { describe, expect, test } from "vitest";
import { detectDeviceLaunchIntents, targetMatchesRunningDevice } from "./device-launch-commands.js";

describe("detectDeviceLaunchIntents", () => {
  test("recognizes the ways an agent boots a simulator", () => {
    expect(detectDeviceLaunchIntents("xcrun simctl boot 'iPhone 17 Pro'")).toEqual([
      { platform: "ios", command: "xcrun simctl boot", target: "iPhone 17 Pro" },
    ]);
    expect(detectDeviceLaunchIntents("simctl boot A0A912ED-C766-4778-957C-F9680C7309F3")).toEqual([
      {
        platform: "ios",
        command: "xcrun simctl boot",
        target: "A0A912ED-C766-4778-957C-F9680C7309F3",
      },
    ]);
    expect(detectDeviceLaunchIntents("open -a Simulator")).toEqual([
      { platform: "ios", command: "open -a Simulator" },
    ]);
  });

  test("recognizes an xcodebuild destination that would boot a simulator", () => {
    expect(
      detectDeviceLaunchIntents(
        "xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build",
      ),
    ).toEqual([{ platform: "ios", command: "xcodebuild -destination", target: "iPhone 17 Pro" }]);
    // A real device or a Mac destination boots nothing.
    expect(
      detectDeviceLaunchIntents("xcodebuild -scheme App -destination 'platform=macOS' build"),
    ).toEqual([]);
  });

  test("recognizes both spellings of an emulator start", () => {
    expect(detectDeviceLaunchIntents("emulator -avd Pixel_7_API_34 -no-snapshot")).toEqual([
      { platform: "android", command: "emulator", target: "Pixel_7_API_34" },
    ]);
    expect(detectDeviceLaunchIntents("$ANDROID_HOME/emulator/emulator @Pixel_7_API_34 &")).toEqual([
      { platform: "android", command: "emulator", target: "Pixel_7_API_34" },
    ]);
  });

  test("classifies each half of a chained command", () => {
    expect(
      detectDeviceLaunchIntents("xcrun simctl boot 'iPhone 17 Pro' && emulator -avd Pixel_7"),
    ).toEqual([
      { platform: "ios", command: "xcrun simctl boot", target: "iPhone 17 Pro" },
      { platform: "android", command: "emulator", target: "Pixel_7" },
    ]);
  });

  test("sees through env prefixes and a cd", () => {
    expect(
      detectDeviceLaunchIntents("cd ~/mobile && ANDROID_SDK_ROOT=/opt/sdk emulator -avd Pixel_7"),
    ).toEqual([{ platform: "android", command: "emulator", target: "Pixel_7" }]);
  });

  test("ignores commands that talk about devices without booting one", () => {
    for (const command of [
      "grep -rn 'simctl boot' docs/",
      "echo 'run emulator -avd Pixel_7 first'",
      "adb -s emulator-5554 install app.apk",
      "./gradlew installDebug",
      "xcrun simctl launch booted com.example.app",
      "xcrun simctl shutdown all",
      "emulator -list-avds",
    ]) {
      expect(detectDeviceLaunchIntents(command), command).toEqual([]);
    }
  });

  test("recognizes the cross-platform runners", () => {
    expect(detectDeviceLaunchIntents("npx expo run:ios")).toEqual([
      { platform: "ios", command: "expo run:ios" },
    ]);
    expect(detectDeviceLaunchIntents("npx react-native run-android")).toEqual([
      { platform: "android", command: "react-native run-android" },
    ]);
  });
});

describe("targetMatchesRunningDevice", () => {
  const simulator = { platform: "ios" as const, deviceId: "A0A912ED-C766-4778-957C-F9680C7309F3" };

  test("matches a UDID case-insensitively, so re-booting a running device costs no slot", () => {
    expect(
      targetMatchesRunningDevice("a0a912ed-c766-4778-957c-f9680c7309f3", simulator, "ios"),
    ).toBe(true);
  });

  test("matches an AVD name exactly", () => {
    expect(
      targetMatchesRunningDevice(
        "Pixel_7",
        { platform: "android", deviceId: "Pixel_7" },
        "android",
      ),
    ).toBe(true);
  });

  test("a device name is not a UDID, so it never claims a running device", () => {
    expect(targetMatchesRunningDevice("iPhone 17 Pro", simulator, "ios")).toBe(false);
    expect(targetMatchesRunningDevice(undefined, simulator, "ios")).toBe(false);
  });
});
