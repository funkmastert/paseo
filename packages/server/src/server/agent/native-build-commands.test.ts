import { describe, expect, test } from "vitest";
import {
  detectNativeBuildIntents,
  findGradleBuildTask,
  findXcodebuildBuildAction,
} from "./native-build-commands.js";

/** What the gate would name for each build in a command; empty when nothing is a build. */
function builds(command: string): string[] {
  return detectNativeBuildIntents(command).map((intent) => intent.command);
}

describe("detectNativeBuildIntents", () => {
  // Commands this fleet's agents ran, from their transcripts (2026-09 and 2026-10), with paths
  // shortened. Each one runs a native build.
  test.each([
    [
      'cd ~/mobile-worktrees/_main-pixel-build/apps/mobile/android && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && APP_ENV=development NODE_ENV=development ./gradlew :app:assembleDebug --console=plain',
      "gradlew :app:assembleDebug",
    ],
    [
      'cd android && APP_ENV=development ./gradlew :app:assembleDebug --max-workers=4 -Dorg.gradle.jvmargs="-Xmx4g" > /tmp/pod-pixel-build.log 2>&1; echo "GRADLE_EXIT $?"',
      "gradlew :app:assembleDebug",
    ],
    [
      "APP_ENV=development ./gradlew --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process :app:assembleDebug > /tmp/pod-pixel-build2.log 2>&1",
      "gradlew :app:assembleDebug",
    ],
    [
      './gradlew :motion-mobile-core:testDebugUnitTest --tests "motion.mobilecore.helpers.DealDeepLinkParserTest" --tests "motion.mobilecore.ui.navigation.DeepLinkUriRouterTest" 2>&1 | tail -80',
      "gradlew :motion-mobile-core:testDebugUnitTest",
    ],
    [
      'nohup ./gradlew :motion-mobile-core:compileDebugUnitTestKotlin --console=plain > /tmp/dna-warm.log 2>&1 & echo "started $!"',
      "gradlew :motion-mobile-core:compileDebugUnitTestKotlin",
    ],
    [
      "./gradlew :motion-mobile-core:verifyRoborazziDebug -PscreenshotTestsOnly --console=plain --tests '*NotesFormattingToolbarScreenshotTest*'",
      "gradlew :motion-mobile-core:verifyRoborazziDebug",
    ],
    [
      "(APP_ENV=development nohup ./gradlew :app:assembleDebug > /tmp/assemble.log 2>&1; echo EXIT $? >> /tmp/assemble.log) &",
      "gradlew :app:assembleDebug",
    ],
    [
      'nice xcodebuild test -scheme MobileCore-Package -destination "platform=iOS Simulator,id=1A9C8E3A-A8AC-4FAB-9286-D970E0F83945" -skipPackagePluginValidation',
      "xcodebuild test",
    ],
    [
      "scripts/run-xcodebuild-with-package-retry.sh -workspace ios/Wonderly.xcworkspace -scheme Wonderly -configuration Debug-Development -destination id=00000000-0000FAKE0000000A",
      "xcodebuild build",
    ],
    [
      "cd /tmp/swift-protobuf && nohup swift build -c release --product protoc-gen-swift > /tmp/pgs-build.log 2>&1 & echo started",
      "swift build",
    ],
    [
      'swift test --filter "DealDeepLinkParserTests|DeepLinkRouterTests" 2>&1 | tail -100',
      "swift test",
    ],
  ])("a fleet build: %s", (command, expected) => {
    expect(builds(command)).toEqual([expected]);
  });

  // Commands this fleet's agents ran that inspect, search or signal, and build nothing.
  test.each([
    "./gradlew :mobile-core:projects 2>&1 | tail -5",
    './gradlew projects -q 2>&1 | grep -i "mobile-core"',
    "./gradlew :motion-mobile-core:ktlintCheck 2>&1 | tail -15",
    "./gradlew :motion-mobile-core:ktlintFormat --console=plain 2>&1 | tail -15",
    "./apps/mobile/android/gradlew -v 2>&1 | head -5",
    "timeout 200 xcodebuild -project Wonderly.xcodeproj -target Wonderly -configuration Debug-Development -showBuildSettings 2>&1 | tail -20",
    'for c in Debug-Development Release-Production; do echo "== $c"; xcodebuild -project Wonderly.xcodeproj -target Wonderly -configuration $c -showBuildSettings 2>&1 | grep -E "INFOPLIST_FILE"; done',
    "xcodebuild -version | head -1",
    'pkill -f "xcodebuild test -scheme MobileCore-Package" 2>/dev/null; sleep 3',
    'pgrep -fl "GradleWrapperMain|gradlew" | head',
    'while pgrep -f "xcodebuild -project Wonderly.xcodeproj" >/dev/null 2>&1; do sleep 20; done',
    "swift build -c release --product protoc-gen-swift --show-bin-path 2>/dev/null",
    'grep -rn "xcodebuild test" docs/',
    "echo './gradlew assembleDebug'",
  ])("not a build: %s", (command) => {
    expect(builds(command)).toEqual([]);
  });

  test.each([
    ["./gradlew assembleRelease", "gradlew assembleRelease"],
    ["gradle build", "gradle build"],
    ["gradlew.bat :app:bundleRelease", "gradlew :app:bundleRelease"],
    ["./gradlew installDebug", "gradlew installDebug"],
    ["./gradlew connectedAndroidTest", "gradlew connectedAndroidTest"],
    ["./gradlew clean assembleDebug", "gradlew assembleDebug"],
    ["./gradlew check", "gradlew check"],
    ["./gradlew lintDebug", "gradlew lintDebug"],
    ["xcodebuild -scheme App -sdk iphonesimulator", "xcodebuild build"],
    ["xcodebuild -workspace App.xcworkspace -scheme App archive", "xcodebuild archive"],
    ["xcodebuild build-for-testing -scheme App", "xcodebuild build-for-testing"],
    [
      "xcodebuild test-without-building -xctestrun App.xctestrun",
      "xcodebuild test-without-building",
    ],
    ["xcrun xcodebuild -scheme App build", "xcodebuild build"],
    ["swift-build -c release", "swift build"],
    ["npx expo run:ios --device 'iPhone 17 Pro'", "expo run:ios"],
    ["bunx expo run:android", "expo run:android"],
    ["pnpm exec expo run:ios", "expo run:ios"],
    ["npx react-native run-android", "react-native run-android"],
    ["npx react-native build-ios --mode Release", "react-native build-ios"],
    ["npx eas build --platform ios --local", "eas build --local"],
    [
      "nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh ./gradlew assembleDebug",
      "gradlew assembleDebug",
    ],
    ["timeout -s KILL 1800 xcodebuild test -scheme App", "xcodebuild test"],
    ["caffeinate -i ./gradlew assembleDebug", "gradlew assembleDebug"],
    ["if ./gradlew assembleDebug; then echo ok; fi", "gradlew assembleDebug"],
    // Package scripts that end in a native build: this repo's own `android` and `ios` scripts.
    ["npm run android", "npm run android"],
    ["npm run android --workspace=@getpaseo/app", "npm run android"],
    ["npm run ios -w app", "npm run ios"],
    ["npm --prefix packages/app run ios", "npm run ios"],
    ["yarn ios", "yarn ios"],
    ["yarn workspace @getpaseo/app android", "yarn android"],
    ["pnpm run build:android", "pnpm run build:android"],
    ["pnpm --filter app ios", "pnpm ios"],
    ["bun run ios", "bun run ios"],
    // Shells that run the build.
    ["bash ./gradlew assembleDebug", "gradlew assembleDebug"],
    ["sh gradlew build", "gradlew build"],
    ["bash -lc './gradlew :app:assembleDebug'", "gradlew :app:assembleDebug"],
    ['sh -c "cd android && ./gradlew installDebug"', "gradlew installDebug"],
    ["zsh -c 'xcodebuild test -scheme App'", "xcodebuild test"],
    // Windows: PowerShell's `.\` and cmd's `/c`.
    [".\\gradlew.bat assembleDebug", "gradlew assembleDebug"],
    ["cmd /c gradlew.bat assembleRelease", "gradlew assembleRelease"],
  ])("recognizes %s", (command, expected) => {
    expect(builds(command)).toEqual([expected]);
  });

  test.each([
    "./gradlew tasks",
    "./gradlew --stop",
    "./gradlew --status",
    "./gradlew assembleDebug --dry-run",
    "./gradlew assembleDebug -m",
    "./gradlew buildEnvironment",
    "./gradlew dependencies --configuration debugRuntimeClasspath",
    "./gradlew clean",
    "./gradlew uninstallAll",
    "./gradlew help --task assembleDebug",
    "xcodebuild -list",
    "xcodebuild -showdestinations -scheme App",
    "xcodebuild -resolvePackageDependencies -workspace App.xcworkspace -scheme App",
    "xcodebuild clean -scheme App",
    "xcodebuild -exportArchive -archivePath App.xcarchive -exportPath out",
    "swift package resolve",
    "npx expo start",
    "npx expo prebuild",
    "npx eas build --platform ios",
    "npx react-native start",
    "npm run lint",
    "npm run typecheck",
    "yarn test",
    "bash -c 'echo ./gradlew assembleDebug'",
    "sh ./scripts/lint.sh",
    // Long-lived: they never finish on their own, so they would hold the slot for their life.
    "./gradlew assembleDebug --continuous",
    "./gradlew -t test",
    "swift run MyServer",
    "swift-run MyServer",
    "xcodebuild -license",
    "xcodebuild -find clang",
    "xcodebuild -find-executable clang",
    "xcodebuild -find-library libswiftCore.dylib",
    "xcodebuild -showBuildSettingsForIndex -scheme App",
  ])("does not count %s", (command) => {
    expect(builds(command)).toEqual([]);
  });

  test("each build names the launcher that will run it, so a grant can follow it in the scan", () => {
    const launchers = (command: string) =>
      detectNativeBuildIntents(command).map((intent) => intent.launcher);
    expect(
      launchers("nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh ./gradlew :app:assembleDebug"),
    ).toEqual([{ program: "gradlew", argument: ":app:assembleDebug" }]);
    expect(launchers("xcodebuild -scheme App")).toEqual([{ program: "xcodebuild" }]);
    expect(launchers("xcodebuild test -scheme App")).toEqual([
      { program: "xcodebuild", argument: "test" },
    ]);
    expect(launchers("npx expo run:ios")).toEqual([{ program: "expo", argument: "run:ios" }]);
    expect(launchers("npm run android")).toEqual([{ program: "npm", argument: "android" }]);
    expect(launchers("swift build -c release")).toEqual([{ program: "swift", argument: "build" }]);
  });

  test("a chained command asks once per build it runs", () => {
    expect(builds("./gradlew assembleDebug && ./gradlew installDebug")).toEqual([
      "gradlew assembleDebug",
      "gradlew installDebug",
    ]);
  });
});

describe("argument classifiers", () => {
  test("a Gradle flag's value is never read as a task", () => {
    expect(findGradleBuildTask(["-x", "lint", "tasks"])).toBeUndefined();
    expect(findGradleBuildTask(["--tests", "testFoo", "help"])).toBeUndefined();
    expect(findGradleBuildTask(["-p", "android", ":app:assembleDebug"])).toBe(":app:assembleDebug");
  });

  test("an xcodebuild flag's value is never read as an action", () => {
    expect(findXcodebuildBuildAction(["-scheme", "test", "clean"])).toBeUndefined();
    expect(findXcodebuildBuildAction(["-scheme", "build"])).toBe("build");
    expect(findXcodebuildBuildAction(["clean", "build"])).toBe("build");
  });
});
