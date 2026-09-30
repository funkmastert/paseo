import { describe, expect, test } from "vitest";
import { detectInstallCommandIntents } from "./device-install-commands.js";

describe("detectInstallCommandIntents", () => {
  test("adb install with -s targets that serial", () => {
    expect(detectInstallCommandIntents("adb -s FAKESERIAL001 install app.apk")).toEqual([
      {
        platform: "android",
        command: "adb install",
        target: "FAKESERIAL001",
        installsOnAllIfUntargeted: false,
      },
    ]);
  });

  test("adb install with no -s is untargeted but not dangerous-if-untargeted (adb itself refuses >1 device)", () => {
    expect(detectInstallCommandIntents("adb install app.apk")).toEqual([
      { platform: "android", command: "adb install", installsOnAllIfUntargeted: false },
    ]);
  });

  test("ANDROID_SERIAL env targets adb the same as -s", () => {
    expect(
      detectInstallCommandIntents("ANDROID_SERIAL=FAKESERIAL002 adb uninstall com.example"),
    ).toEqual([
      {
        platform: "android",
        command: "adb uninstall",
        target: "FAKESERIAL002",
        installsOnAllIfUntargeted: false,
      },
    ]);
  });

  test("adb shell am start and pm clear are gated", () => {
    expect(
      detectInstallCommandIntents("adb -s FAKESERIAL001 shell am start -n com.example/.Main"),
    ).toEqual([
      expect.objectContaining({ command: "adb shell am start", target: "FAKESERIAL001" }),
    ]);
    expect(detectInstallCommandIntents("adb shell pm clear com.example")).toEqual([
      expect.objectContaining({ command: "adb shell pm clear" }),
    ]);
  });

  test("adb devices and adb logcat are read-only and never gated", () => {
    expect(detectInstallCommandIntents("adb devices -l")).toEqual([]);
    expect(detectInstallCommandIntents("adb logcat")).toEqual([]);
    expect(detectInstallCommandIntents("adb shell getprop")).toEqual([]);
  });

  test("gradlew installDebug installs on every connected device unless ANDROID_SERIAL is set", () => {
    expect(detectInstallCommandIntents("./gradlew installDebug")).toEqual([
      { platform: "android", command: "gradlew installDebug", installsOnAllIfUntargeted: true },
    ]);
    expect(
      detectInstallCommandIntents("ANDROID_SERIAL=FAKESERIAL003 ./gradlew installRelease"),
    ).toEqual([
      {
        platform: "android",
        command: "gradlew installRelease",
        target: "FAKESERIAL003",
        installsOnAllIfUntargeted: true,
      },
    ]);
  });

  test("gradlew tasks that are not installs are not gated", () => {
    expect(detectInstallCommandIntents("./gradlew build")).toEqual([]);
    expect(detectInstallCommandIntents("./gradlew test")).toEqual([]);
  });

  test("expo run:android/ios is gated only with --device", () => {
    expect(detectInstallCommandIntents("expo run:android --device FAKESERIAL004")).toEqual([
      {
        platform: "android",
        command: "expo run:android --device",
        target: "FAKESERIAL004",
        installsOnAllIfUntargeted: false,
      },
    ]);
    expect(detectInstallCommandIntents("npx expo run:ios --device 00001-FAKE-UDID")).toEqual([
      expect.objectContaining({ platform: "ios", target: "00001-FAKE-UDID" }),
    ]);
    // No --device: boots a simulator/emulator, which device-launch-commands.ts covers.
    expect(detectInstallCommandIntents("expo run:android")).toEqual([]);
  });

  test("react-native run-android --deviceId and run-ios --udid are gated", () => {
    expect(
      detectInstallCommandIntents("react-native run-android --deviceId FAKESERIAL005"),
    ).toEqual([expect.objectContaining({ platform: "android", target: "FAKESERIAL005" })]);
    expect(detectInstallCommandIntents("react-native run-ios --udid 00002-FAKE-UDID")).toEqual([
      expect.objectContaining({ platform: "ios", target: "00002-FAKE-UDID" }),
    ]);
    expect(detectInstallCommandIntents("react-native run-android")).toEqual([]);
  });

  test("devicectl device install and process launch are gated on --device", () => {
    expect(
      detectInstallCommandIntents("xcrun devicectl device install app --device 00003-FAKE-UDID"),
    ).toEqual([
      expect.objectContaining({ command: "devicectl device install", target: "00003-FAKE-UDID" }),
    ]);
    expect(
      detectInstallCommandIntents(
        "xcrun devicectl process launch --device 00003-FAKE-UDID com.example",
      ),
    ).toEqual([
      expect.objectContaining({ command: "devicectl process launch", target: "00003-FAKE-UDID" }),
    ]);
  });

  test("xcodebuild -destination targets a physical device by id or name, not a simulator", () => {
    expect(
      detectInstallCommandIntents("xcodebuild test -destination 'id=00004-FAKE-UDID'"),
    ).toEqual([expect.objectContaining({ platform: "ios", target: "00004-FAKE-UDID" })]);
    expect(
      detectInstallCommandIntents("xcodebuild test -destination 'platform=iOS,name=Fake Phone'"),
    ).toEqual([expect.objectContaining({ platform: "ios", target: "Fake Phone" })]);
    expect(
      detectInstallCommandIntents(
        "xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17 Pro'",
      ),
    ).toEqual([]);
  });

  test("ios-deploy --id is gated", () => {
    expect(detectInstallCommandIntents("ios-deploy --id 00005-FAKE-UDID --bundle app.app")).toEqual(
      [expect.objectContaining({ platform: "ios", target: "00005-FAKE-UDID" })],
    );
  });

  test("flutter run -d targets a device of unknown platform, resolved by the caller", () => {
    expect(detectInstallCommandIntents("flutter run -d FAKESERIAL006")).toEqual([
      {
        platform: "unknown",
        command: "flutter run -d",
        target: "FAKESERIAL006",
        installsOnAllIfUntargeted: false,
      },
    ]);
    expect(detectInstallCommandIntents("flutter run")).toEqual([]);
  });

  test("a chained command line gates each segment independently", () => {
    const intents = detectInstallCommandIntents(
      "adb -s FAKESERIAL001 install app.apk && echo done",
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ target: "FAKESERIAL001" });
  });

  test("a comment or grep mentioning these commands is not a command", () => {
    expect(detectInstallCommandIntents("grep -rn 'adb install' docs/")).toEqual([]);
  });
});
