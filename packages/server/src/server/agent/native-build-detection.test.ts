import { describe, expect, test } from "vitest";
import { scanNativeBuilds } from "./native-build-detection.js";
import type { AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

const STUDIO_JAVA = "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java";
const XCODEBUILD = "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild";
const SWIFT_FRONTEND =
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend";
const BUILD_SERVICE =
  "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";

function row(pid: number, ppid: number, command: string, etime = "04:12"): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 1000, cpuPercent: 0, etime, command };
}

/** `gradlew` as Gradle 9.7.1's wrapper script launches it. */
function gradlewClient(pid: number, ppid: number, args: string): ProcessSampleRow {
  return row(
    pid,
    ppid,
    `${STUDIO_JAVA} -Xmx64m -Xms64m -Dorg.gradle.appname=gradlew -jar ` +
      `/Users/t/mobile-worktrees/_main-pixel-build/apps/mobile/android/gradle/wrapper/gradle-wrapper.jar ${args}`,
  );
}

function tree(agentId: string, pids: number[]): AgentProcessTree {
  return { agentId, pids, rssBytes: 0, cpuPercent: 0 };
}

function detect(rows: ProcessSampleRow[], agentTrees: AgentProcessTree[] = []) {
  return scanNativeBuilds({ rows, agentTrees }).builds;
}

function runners(rows: ProcessSampleRow[], agentTrees: AgentProcessTree[] = []) {
  return scanNativeBuilds({ rows, agentTrees }).runners;
}

/** A Win32_Process row: CommandLine keeps the quotes cmd and gradlew.bat put around paths. */
function windowsRow(pid: number, ppid: number, name: string, command: string): ProcessSampleRow {
  return { ...row(pid, ppid, command), uid: undefined, name };
}

const WINDOWS_JAVA = '"C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe"';

describe("scanNativeBuilds", () => {
  test("a gradlew client running a build task counts, owned by the agent whose tree runs it", () => {
    const rows = [
      row(100, 1, "claude --mcp-config http://127.0.0.1:6767/mcp?callerAgentId=agent-a"),
      row(101, 100, "/bin/zsh -c ./gradlew :app:assembleDebug"),
      gradlewClient(102, 101, ":app:assembleDebug --console=plain"),
    ];
    expect(detect(rows, [tree("agent-a", [100, 101, 102])])).toEqual([
      { pid: 102, command: "gradlew :app:assembleDebug", etime: "04:12", agentId: "agent-a" },
    ]);
  });

  test("the older main-class launchers and the distribution's cli jar count too", () => {
    const rows = [
      row(
        200,
        1,
        `${STUDIO_JAVA} -classpath /w/gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain testDebugUnitTest`,
      ),
      row(
        201,
        1,
        "/usr/bin/java -jar /Users/t/.gradle/wrapper/dists/gradle-9.7.1-bin/x/gradle-9.7.1/lib/gradle-gradle-cli-main-9.7.1.jar build",
      ),
    ];
    expect(detect(rows).map((build) => build.command)).toEqual([
      "gradlew testDebugUnitTest",
      "gradle build",
    ]);
  });

  test("a wrapper jar under a path with spaces is still read", () => {
    const rows = [
      row(
        300,
        1,
        `${STUDIO_JAVA} -Dorg.gradle.appname=gradlew -jar /Users/t/my repo/android/gradle/wrapper/gradle-wrapper.jar assembleRelease`,
      ),
    ];
    expect(detect(rows).map((build) => build.command)).toEqual(["gradlew assembleRelease"]);
  });

  test("the Gradle daemon, a client running a read-only task, and a search for one never count", () => {
    const rows = [
      row(
        400,
        1,
        `${STUDIO_JAVA} -Xmx6g -cp /Users/t/.gradle/lib/gradle-daemon-main-9.7.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1`,
      ),
      gradlewClient(401, 1, "tasks --all"),
      gradlewClient(402, 1, "--stop"),
      row(403, 1, "pgrep -fl GradleWrapperMain|gradlew"),
      row(404, 1, "grep -rn org.gradle.wrapper.GradleWrapperMain assembleDebug"),
    ];
    expect(detect(rows)).toEqual([]);
  });

  test("xcodebuild counts for a build action and not for an inspection or a search", () => {
    const rows = [
      row(
        500,
        1,
        `${XCODEBUILD} test -scheme MobileCore-Package -destination platform=iOS Simulator,id=1A9C`,
      ),
      row(501, 1, `${XCODEBUILD} -project Wonderly.xcodeproj -target Wonderly -showBuildSettings`),
      row(502, 1, "pgrep -f xcodebuild -project Wonderly.xcodeproj"),
      row(503, 1, `/Applications/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild -scheme App`),
    ];
    expect(detect(rows).map((build) => [build.pid, build.command])).toEqual([
      [500, "xcodebuild test"],
      [503, "xcodebuild build"],
    ]);
  });

  test("an xcodebuild's own build service and compile jobs count once, as the xcodebuild", () => {
    const rows = [
      row(600, 1, `${XCODEBUILD} -workspace ios/Wonderly.xcworkspace -scheme Wonderly build`),
      row(601, 600, BUILD_SERVICE),
      row(602, 601, `${SWIFT_FRONTEND} -frontend -c -primary-file A.swift`),
      row(603, 601, `${SWIFT_FRONTEND} -frontend -c -primary-file B.swift`),
    ];
    expect(detect(rows).map((build) => build.pid)).toEqual([600]);
  });

  test("compile jobs under no counted build are one Xcode build per build service; indexing is not", () => {
    const rows = [
      row(700, 1, BUILD_SERVICE),
      row(701, 700, `${SWIFT_FRONTEND} -frontend -c -primary-file A.swift`),
      row(702, 700, `${SWIFT_FRONTEND} -frontend -c -primary-file B.swift`),
      row(710, 1, BUILD_SERVICE),
      row(711, 710, `${SWIFT_FRONTEND} -frontend -c -index-file -index-file-path A.swift`),
    ];
    expect(detect(rows)).toEqual([
      { pid: 700, command: "swift-frontend under SWBBuildService", etime: "04:12" },
    ]);
  });

  test("swift build and the swift-build it runs count once", () => {
    const rows = [
      row(800, 1, "/usr/bin/swift build -c release --product protoc-gen-swift"),
      row(
        801,
        800,
        "/Library/Developer/CommandLineTools/usr/bin/swift-build -c release --product protoc-gen-swift",
      ),
      row(802, 801, `${SWIFT_FRONTEND} -frontend -c -primary-file main.swift`),
      row(810, 1, "/usr/bin/swift build --show-bin-path"),
    ];
    expect(detect(rows).map((build) => [build.pid, build.command])).toEqual([[800, "swift build"]]);
  });

  test("Windows: gradlew.bat's quoted java.exe and jar paths are read, in both launcher forms", () => {
    const rows = [
      windowsRow(
        1000,
        1,
        "java.exe",
        `${WINDOWS_JAVA} -Xmx64m -Xms64m "-Dorg.gradle.appname=gradlew" -jar "C:\\w\\my app\\android\\gradle\\wrapper\\gradle-wrapper.jar" assembleDebug`,
      ),
      windowsRow(
        1001,
        1,
        "java.exe",
        `${WINDOWS_JAVA} "-Dorg.gradle.appname=gradlew" -classpath "C:\\w\\android\\gradle\\wrapper\\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain :app:assembleRelease`,
      ),
      windowsRow(
        1002,
        1,
        "java.exe",
        `${WINDOWS_JAVA} -jar "C:\\w\\gradle\\wrapper\\gradle-wrapper.jar" tasks`,
      ),
    ];
    expect(detect(rows).map((build) => build.command)).toEqual([
      "gradlew assembleDebug",
      "gradlew :app:assembleRelease",
    ]);
  });

  test("runs that never end on their own are not builds: --continuous, swift run, -license, -interpret", () => {
    const rows = [
      gradlewClient(1100, 1, "assembleDebug --continuous"),
      row(1101, 1, "/usr/bin/swift run MyServer"),
      row(1102, 1, "/Library/Developer/CommandLineTools/usr/bin/swift-run MyServer"),
      row(1103, 1, `${XCODEBUILD} -license`),
      row(1104, 1, BUILD_SERVICE),
      row(1105, 1104, `${SWIFT_FRONTEND} -frontend -interpret script.swift`),
    ];
    expect(detect(rows)).toEqual([]);
  });

  test("an expo run is a runner while it sets up, and building once its native build is under it", () => {
    const rows = [
      row(
        1200,
        1,
        "/opt/homebrew/bin/node /w/node_modules/.bin/expo run:ios --device iPhone 17 Pro",
      ),
      row(1300, 1, "/opt/homebrew/bin/node /w/node_modules/.bin/expo run:android"),
      row(1301, 1300, "/bin/sh ./gradlew app:installDebug"),
      gradlewClient(1302, 1301, "app:installDebug"),
    ];
    expect(runners(rows, [tree("agent-a", [1200])])).toEqual([
      { pid: 1200, command: "expo run:ios", etime: "04:12", agentId: "agent-a", building: false },
      { pid: 1300, command: "expo run:android", etime: "04:12", building: true },
    ]);
    expect(detect(rows).map((build) => build.command)).toEqual(["gradlew app:installDebug"]);
  });

  test("react-native and local eas builds are runners; npx, a cloud eas build and Metro are not", () => {
    const rows = [
      row(1400, 1, "/opt/homebrew/bin/node /w/node_modules/react-native/cli.js run-android"),
      row(1401, 1, "/opt/homebrew/bin/node /usr/local/bin/eas build --platform ios --local"),
      row(1402, 1, "/opt/homebrew/bin/node /usr/local/bin/eas build --platform ios"),
      row(1403, 1, "/opt/homebrew/bin/node /usr/local/bin/npx expo run:ios"),
      row(1404, 1, "/opt/homebrew/bin/node /w/node_modules/.bin/expo start"),
      row(1405, 1, "grep expo run:ios"),
      windowsRow(
        1406,
        1,
        "node.exe",
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\w\\node_modules\\expo\\bin\\cli" run:android',
      ),
    ];
    expect(runners(rows).map((runner) => [runner.pid, runner.command])).toEqual([
      [1400, "react-native run-android"],
      [1401, "eas build --local"],
      [1406, "expo run:android"],
    ]);
  });

  test("the Gradle client an expo run starts is the build, counted once", () => {
    const rows = [
      row(900, 1, "node /w/node_modules/.bin/expo run:android"),
      row(901, 900, "/bin/sh ./gradlew app:installDebug -x lint"),
      gradlewClient(902, 901, "app:installDebug -x lint"),
    ];
    expect(detect(rows).map((build) => build.command)).toEqual(["gradlew app:installDebug"]);
  });
});
