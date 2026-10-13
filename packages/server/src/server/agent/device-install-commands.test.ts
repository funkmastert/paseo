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

  test("a serial set via a shell variable earlier in the same command resolves, not the literal $VAR", () => {
    // The exact shape from the incident: S=<serial>; ...; adb -s $S install -r -d $APK — the
    // agent's own shell resolves $S to the real serial. Without resolving it here too, the
    // matcher reads the target as the device literally named "$S" (which nothing is ever
    // connected as), so gateIntent treats it as "nothing to protect" and lets the install run
    // unguarded against whichever device $S actually names.
    expect(
      detectInstallCommandIntents(
        "S=FAKESERIAL001; APP=com.example; APK=app.apk; adb -s $S install -r -d $APK",
      ),
    ).toEqual([expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" })]);
  });

  test("${VAR} braced form resolves the same way", () => {
    expect(detectInstallCommandIntents("S=FAKESERIAL001; adb -s ${S} install app.apk")).toEqual([
      expect.objectContaining({ target: "FAKESERIAL001" }),
    ]);
  });

  test("ANDROID_SERIAL set via a shell variable earlier resolves for a gradle install task", () => {
    expect(
      detectInstallCommandIntents("S=FAKESERIAL001; ANDROID_SERIAL=$S ./gradlew installDebug"),
    ).toEqual([
      expect.objectContaining({ command: "gradlew installDebug", target: "FAKESERIAL001" }),
    ]);
  });

  test("a later assignment overrides an earlier one, like a real shell", () => {
    expect(
      detectInstallCommandIntents("S=FAKESERIAL001; S=FAKESERIAL002; adb -s $S install app.apk"),
    ).toEqual([expect.objectContaining({ target: "FAKESERIAL002" })]);
  });

  test("an unresolvable variable (no assignment seen in this command) is marked unresolved, not read as a literal device name", () => {
    // It still names exactly one real device — just not one this gate's text matcher can read.
    // Reading it as the literal string "$EXPORTED_ELSEWHERE" would make the caller treat it as
    // "names a device nothing is connected as" and wave the install through unguarded.
    expect(detectInstallCommandIntents("adb -s $EXPORTED_ELSEWHERE install app.apk")).toEqual([
      expect.objectContaining({ target: "$EXPORTED_ELSEWHERE", targetUnresolved: true }),
    ]);
  });

  test("iOS: a UDID set via a shell variable resolves for devicectl, ios-deploy and xcodebuild -destination", () => {
    expect(
      detectInstallCommandIntents(
        "UDID=00005-FAKE-UDID; xcrun devicectl device install app --device $UDID --app app.app",
      ),
    ).toEqual([expect.objectContaining({ platform: "ios", target: "00005-FAKE-UDID" })]);
    expect(
      detectInstallCommandIntents("UDID=00005-FAKE-UDID; ios-deploy --id $UDID --bundle app.app"),
    ).toEqual([expect.objectContaining({ platform: "ios", target: "00005-FAKE-UDID" })]);
    expect(
      detectInstallCommandIntents("UDID=00005-FAKE-UDID; xcodebuild test -destination 'id=$UDID'"),
    ).toEqual([expect.objectContaining({ platform: "ios", target: "00005-FAKE-UDID" })]);
  });

  test("export NAME=value resolves the same as a bare assignment", () => {
    expect(
      detectInstallCommandIntents("export S=FAKESERIAL001; adb -s $S install app.apk"),
    ).toEqual([expect.objectContaining({ target: "FAKESERIAL001" })]);
  });

  test("export A=1 B=2 resolves both assignments in one export", () => {
    expect(
      detectInstallCommandIntents(
        "export APP=com.example S=FAKESERIAL001; adb -s $S install app.apk",
      ),
    ).toEqual([expect.objectContaining({ target: "FAKESERIAL001" })]);
  });

  test("declare and readonly resolve the same way as export", () => {
    expect(
      detectInstallCommandIntents("declare S=FAKESERIAL001; adb -s $S install app.apk"),
    ).toEqual([expect.objectContaining({ target: "FAKESERIAL001" })]);
    expect(
      detectInstallCommandIntents("readonly S=FAKESERIAL001; adb -s $S install app.apk"),
    ).toEqual([expect.objectContaining({ target: "FAKESERIAL001" })]);
  });

  test("a $(…) command substitution target is marked unresolved, not split apart or ignored", () => {
    // The incident-adjacent shape Tyler's leader flagged: a pipe inside $(…) must not end the
    // segment early and strand "install" in a fragment with nothing before it.
    expect(
      detectInstallCommandIntents("adb -s $(adb devices | awk 'NR==2{print $1}') install app.apk"),
    ).toEqual([
      expect.objectContaining({
        command: "adb install",
        target: "$(adb devices | awk 'NR==2{print $1}')",
        targetUnresolved: true,
      }),
    ]);
  });

  test("a backtick command substitution target is marked unresolved the same way", () => {
    expect(detectInstallCommandIntents("adb -s `cat /tmp/serial` install app.apk")).toEqual([
      expect.objectContaining({ target: "`cat /tmp/serial`", targetUnresolved: true }),
    ]);
  });

  test("a quoted default-value expansion ($VAR:-default) is marked unresolved, not matched as a literal", () => {
    expect(detectInstallCommandIntents('adb -s "${S:-x}" install app.apk')).toEqual([
      expect.objectContaining({ target: "${S:-x}", targetUnresolved: true }),
    ]);
  });

  test("an unterminated $(...) doesn't swallow a later adb install — it falls back to literal tokenization", () => {
    // A real shell refuses to run this (missing close paren), so the swallowed command never
    // executes there — but the gate must not silently fail to see the adb install either.
    expect(
      detectInstallCommandIntents("echo $(uname -s && adb -s FAKESERIAL001 install evil.apk"),
    ).toEqual([expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" })]);
  });

  test("an unterminated backtick doesn't swallow a later adb install either", () => {
    expect(
      detectInstallCommandIntents("echo `uname -s && adb -s FAKESERIAL001 install evil.apk"),
    ).toEqual([expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" })]);
  });

  test("xargs is stripped so a piped adb install is still gated", () => {
    expect(detectInstallCommandIntents("ls *.apk | xargs adb -s FAKESERIAL001 install")).toEqual([
      expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" }),
    ]);
  });

  test("xargs with flags (-0, -n1) is stripped the same way", () => {
    expect(
      detectInstallCommandIntents(
        "find . -name '*.apk' -print0 | xargs -0 adb -s FAKESERIAL001 install",
      ),
    ).toEqual([expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" })]);
    expect(
      detectInstallCommandIntents("echo FAKESERIAL001 | xargs -n1 adb -s FAKESERIAL001 install"),
    ).toEqual([expect.objectContaining({ command: "adb install", target: "FAKESERIAL001" })]);
  });

  test("xargs -I{} with a {} placeholder target is marked unresolved, not read as a literal device", () => {
    expect(detectInstallCommandIntents("adb devices | xargs -I{} adb -s {} install x.apk")).toEqual(
      [expect.objectContaining({ target: "{}", targetUnresolved: true })],
    );
  });
});
