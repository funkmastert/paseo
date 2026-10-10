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
        stateOnly: false,
      },
    ]);
  });

  test("adb install with no -s is untargeted but not dangerous-if-untargeted (adb itself refuses >1 device)", () => {
    expect(detectInstallCommandIntents("adb install app.apk")).toEqual([
      {
        platform: "android",
        command: "adb install",
        installsOnAllIfUntargeted: false,
        stateOnly: false,
      },
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
        stateOnly: false,
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
      {
        platform: "android",
        command: "gradlew installDebug",
        installsOnAllIfUntargeted: true,
        stateOnly: false,
      },
    ]);
    expect(
      detectInstallCommandIntents("ANDROID_SERIAL=FAKESERIAL003 ./gradlew installRelease"),
    ).toEqual([
      {
        platform: "android",
        command: "gradlew installRelease",
        target: "FAKESERIAL003",
        installsOnAllIfUntargeted: true,
        stateOnly: false,
      },
    ]);
  });

  test("gradlew tasks that are not installs are not gated", () => {
    expect(detectInstallCommandIntents("./gradlew build")).toEqual([]);
    expect(detectInstallCommandIntents("./gradlew test")).toEqual([]);
  });

  test("a long non-install module task is rejected in linear time", () => {
    // The old pattern backtracked exponentially here and froze the daemon's event loop.
    const started = performance.now();
    expect(
      detectInstallCommandIntents(
        "./gradlew :motion-mobile-core:testDebugUnitTest :motion-mobile-core-with-a-much-longer-name:ktlintCheck",
      ),
    ).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
    expect(detectInstallCommandIntents("./gradlew appinstallDebug")).toEqual([]);
  });

  test("expo run:android/ios is gated only with --device", () => {
    expect(detectInstallCommandIntents("expo run:android --device FAKESERIAL004")).toEqual([
      {
        platform: "android",
        command: "expo run:android --device",
        target: "FAKESERIAL004",
        installsOnAllIfUntargeted: false,
        stateOnly: false,
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

  test("devicectl device install, uninstall and process launch are gated on --device", () => {
    expect(
      detectInstallCommandIntents("xcrun devicectl device install app --device 00003-FAKE-UDID"),
    ).toEqual([
      expect.objectContaining({ command: "devicectl device install", target: "00003-FAKE-UDID" }),
    ]);
    expect(
      detectInstallCommandIntents(
        "xcrun devicectl device process launch --device 00003-FAKE-UDID com.example",
      ),
    ).toEqual([
      expect.objectContaining({
        command: "devicectl device process launch",
        target: "00003-FAKE-UDID",
      }),
    ]);
    expect(
      detectInstallCommandIntents("xcrun devicectl device uninstall app -d 00003-FAKE-UDID com.x"),
    ).toEqual([
      expect.objectContaining({ command: "devicectl device uninstall", target: "00003-FAKE-UDID" }),
    ]);
    expect(detectInstallCommandIntents("xcrun devicectl list devices")).toEqual([]);
    expect(
      detectInstallCommandIntents("xcrun devicectl device info apps --device 00003-FAKE-UDID"),
    ).toEqual([]);
  });

  test("gradle module tasks and connected tests install on every device", () => {
    for (const task of [":app:installDebug", "app:installDebug", ":app:uninstallAll"]) {
      expect(detectInstallCommandIntents(`./gradlew ${task}`), task).toEqual([
        expect.objectContaining({
          platform: "android",
          installsOnAllIfUntargeted: true,
          stateOnly: false,
        }),
      ]);
    }
    expect(detectInstallCommandIntents("./gradlew :app:connectedDebugAndroidTest")).toEqual([
      expect.objectContaining({ installsOnAllIfUntargeted: true, stateOnly: false }),
    ]);
    expect(detectInstallCommandIntents("gradle connectedAndroidTest")).toEqual([
      expect.objectContaining({ installsOnAllIfUntargeted: true, stateOnly: false }),
    ]);
    expect(detectInstallCommandIntents("./gradlew :app:assembleDebug")).toEqual([]);
  });

  test("read-only and build-only commands are never gated", () => {
    for (const command of [
      "adb -s FAKESERIAL001 shell pm list packages",
      "adb shell pm path com.example",
      "adb shell am broadcast -a com.example.PING",
      "adb shell am instrument -w com.example.test/androidx.test.runner.AndroidJUnitRunner",
      "adb shell getprop ro.build.version.sdk",
      "adb exec-out screencap -p",
      "adb shell screencap /sdcard/s.png",
      "adb -s FAKESERIAL001 logcat -d",
      "xcodebuild -scheme App -destination 'generic/platform=iOS' archive",
      "xcodebuild build -scheme App -destination 'generic/platform=iOS'",
      "xcodebuild build -scheme App -destination 'id=00004-FAKE-UDID'",
      "ios-deploy --detect",
      "ios-deploy -c",
      "ios-deploy --id 00005-FAKE-UDID --list",
    ]) {
      expect(detectInstallCommandIntents(command), command).toEqual([]);
    }
  });

  test("adb shell installs, clears and launches are gated; force-stop only changes state", () => {
    for (const [command, label] of [
      ["adb shell am start-activity -n com.x/.Main", "adb shell am start-activity"],
      ["adb shell pm install /data/local/tmp/app.apk", "adb shell pm install"],
      ["adb shell pm uninstall com.x", "adb shell pm uninstall"],
    ] as const) {
      expect(detectInstallCommandIntents(command), command).toEqual([
        expect.objectContaining({ command: label, stateOnly: false }),
      ]);
    }
    expect(detectInstallCommandIntents("adb -s FAKESERIAL001 shell am force-stop com.x")).toEqual([
      expect.objectContaining({
        command: "adb shell am force-stop",
        target: "FAKESERIAL001",
        stateOnly: true,
      }),
    ]);
  });

  test("a Windows adb.exe is still adb", () => {
    expect(detectInstallCommandIntents("adb.exe -s FAKESERIAL001 install app.apk")).toEqual([
      expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" }),
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

  test("ios-deploy is gated when it installs, launches or uninstalls", () => {
    expect(detectInstallCommandIntents("ios-deploy --id 00005-FAKE-UDID --bundle app.app")).toEqual(
      [expect.objectContaining({ platform: "ios", target: "00005-FAKE-UDID" })],
    );
    expect(detectInstallCommandIntents("ios-deploy -i 00005-FAKE-UDID -b app.app -L")).toEqual([
      expect.objectContaining({ target: "00005-FAKE-UDID" }),
    ]);
    expect(detectInstallCommandIntents("ios-deploy --uninstall_only --bundle_id com.x")).toEqual([
      expect.objectContaining({ platform: "ios" }),
    ]);
  });

  test("flutter run -d targets a device of unknown platform, resolved by the caller", () => {
    expect(detectInstallCommandIntents("flutter run -d FAKESERIAL006")).toEqual([
      {
        platform: "unknown",
        command: "flutter run -d",
        target: "FAKESERIAL006",
        installsOnAllIfUntargeted: false,
        stateOnly: false,
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
