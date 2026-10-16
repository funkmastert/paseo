import { describe, expect, test } from "vitest";
import {
  isOrphanBuildDaemonCommand,
  matchBuildDaemonSignature,
} from "./build-daemon-signatures.js";

// Observed: copied from `ps -axww -o command` on Tyler's Mac on 2026-09-24 (home directory
// shortened to /Users/t, classpaths trimmed). A live backend agent's build left all three behind.
const VBCSCOMPILER_APPHOST =
  "/Users/t/.dotnet/sdk/10.0.200/Roslyn/bincore/VBCSCompiler " +
  "-pipename:jFFfIURcCsGm+nTDd_yFaEsPUsl0RcQGfd5R8lO8sZk";
const MSBUILD_NODE =
  "/Users/t/.dotnet/dotnet /Users/t/.dotnet/sdk/10.0.200/MSBuild.dll /noautoresponse /nologo " +
  "/nodemode:1 /nodeReuse:true /low:false";
const DOTNET_BUILD_CLIENT =
  "dotnet build src/Motion.Apps.Crm/Motion.Apps.Crm.csproj -p:EnforceCodeStyleInBuild=true";
const KOTLIN_DAEMON =
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java " +
  "-cp /Users/t/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-build-tools-compat/" +
  "2.4.20/d49fbc8a/kotlin-build-tools-compat-2.4.20.jar " +
  "org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-logsPath /var/folders/xx/T " +
  "--daemon-logsFileSizeLimit=1048576 --daemon-logsFileCountLimit=3 " +
  "--daemon-runFilesPath /Users/t/Library/Application Support/kotlin/daemon " +
  "--daemon-autoshutdownIdleSeconds=7200";

// Derived, not observed: no such process was running on this machine. Roslyn ships
// `Roslyn/bincore/VBCSCompiler.dll` beside the apphost, and the Razor SDK's `rzc.dll` and its
// tasks assembly carry a `server` command taking `-p|--pipe` (read out of the SDK's UTF-16 string
// tables) and launch it through the `dotnet` host.
const VBCSCOMPILER_DLL =
  "/Users/t/.dotnet/dotnet /Users/t/.dotnet/sdk/10.0.200/Roslyn/bincore/VBCSCompiler.dll " +
  "-pipename:jFFfIURcCsGm+nTDd_yFaEsPUsl0RcQGfd5R8lO8sZk";
const RAZOR_SERVER =
  "/Users/t/.dotnet/dotnet " +
  "/Users/t/.dotnet/sdk/10.0.200/Sdks/Microsoft.NET.Sdk.Razor/tools/rzc.dll " +
  "server -p rzc-4f2a91c0";
// Metro is one node process running the Expo (or React Native, or Metro) CLI: `expo/bin/cli` only
// `require`s @expo/cli, so argv[1] is the bin shim or that file, followed by the subcommand.
const EXPO_METRO =
  "/Users/t/.nvm/versions/node/v24.18.0/bin/node /Users/t/paseo/node_modules/.bin/expo start --port 8081";

describe("matchBuildDaemonSignature", () => {
  test.each([
    [
      "the Gradle daemon",
      "java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1",
      "gradle",
    ],
    ["the Kotlin compile daemon", KOTLIN_DAEMON, "kotlin"],
    ["Roslyn's VBCSCompiler apphost", VBCSCOMPILER_APPHOST, "vbcscompiler"],
    ["Roslyn's VBCSCompiler under the dotnet host", VBCSCOMPILER_DLL, "vbcscompiler"],
    ["an MSBuild node-reuse worker", MSBUILD_NODE, "msbuild-node"],
    ["the Razor build server", RAZOR_SERVER, "razor-server"],
    ["Metro under expo start", EXPO_METRO, "metro"],
    [
      "Metro under react-native start",
      "node /Users/t/app/node_modules/react-native/cli.js start --port 8081",
      "metro",
    ],
    [
      "Metro under react-native start via the bin shim, with a node flag",
      "node --max-old-space-size=8192 /Users/t/app/node_modules/.bin/react-native start",
      "metro",
    ],
    ["a standalone Metro", "node /Users/t/app/node_modules/metro/src/cli.js serve", "metro"],
  ])("recognises %s", (_name, command, kind) => {
    expect(matchBuildDaemonSignature(command)?.kind).toBe(kind);
  });

  test("labels each kind for the reap push and the log line", () => {
    expect(matchBuildDaemonSignature(VBCSCOMPILER_APPHOST)?.label).toBe(
      ".NET compiler server (VBCSCompiler)",
    );
    expect(matchBuildDaemonSignature(MSBUILD_NODE)?.label).toBe("MSBuild node");
    expect(matchBuildDaemonSignature(RAZOR_SERVER)?.label).toBe("Razor build server");
    expect(matchBuildDaemonSignature(EXPO_METRO)?.label).toBe("Metro bundler");
  });

  test("accepts Windows separators and .exe names", () => {
    expect(
      matchBuildDaemonSignature(
        "C:\\Program Files\\dotnet\\sdk\\10.0.200\\Roslyn\\bincore\\VBCSCompiler.exe -pipename:x",
      )?.kind,
    ).toBe("vbcscompiler");
    expect(
      matchBuildDaemonSignature(
        "C:\\Program Files\\dotnet\\dotnet.exe C:\\Program Files\\dotnet\\sdk\\10.0.200\\MSBuild.dll " +
          "/nodemode:1 /nodeReuse:true",
      )?.kind,
    ).toBe("msbuild-node");
    expect(
      matchBuildDaemonSignature(
        "C:\\Program Files\\dotnet\\dotnet.exe D:\\sdk\\Razor\\tools\\rzc.dll server -p rzc-1",
      )?.kind,
    ).toBe("razor-server");
    expect(
      matchBuildDaemonSignature(
        "C:\\Program Files\\nodejs\\node.exe C:\\proj\\node_modules\\expo\\bin\\cli start",
      )?.kind,
    ).toBe("metro");
    expect(
      matchBuildDaemonSignature(
        "C:\\Program Files\\Java\\bin\\java.exe -cp a.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9",
      )?.kind,
    ).toBe("gradle");
  });

  test.each([
    ["grep for the compiler name", "grep VBCSCompiler"],
    ["grep for the compiler apphost path", "grep -r /x/Roslyn/bincore/VBCSCompiler /x"],
    [
      "an editor holding the apphost path",
      "vim /Users/t/.dotnet/sdk/10.0.200/Roslyn/bincore/VBCSCompiler",
    ],
    ["an editor holding the dll path", "code /x/Roslyn/bincore/VBCSCompiler.dll -pipename:x"],
    ["the dotnet build client", DOTNET_BUILD_CLIENT],
    [
      "an MSBuild client with node reuse but no node mode",
      "dotnet exec /x/sdk/10.0.200/MSBuild.dll -maxcpucount /nodeReuse:true /t:Build a.csproj",
    ],
    [
      "an MSBuild worker with node reuse turned off",
      "/x/dotnet /x/sdk/10.0.200/MSBuild.dll /nodemode:1 /nodeReuse:false",
    ],
    ["an editor on MSBuild.dll", "vim /x/sdk/10.0.200/MSBuild.dll /nodemode:1 /nodeReuse:true"],
    ["a Razor compile, not the server", "/x/dotnet /x/tools/rzc.dll generate -s a.cshtml -o out"],
    ["an editor on rzc.dll", "vim /x/tools/rzc.dll server"],
    ["npm running the expo script", "node /x/npm/bin/npm-cli.js run start:expo -- --port 8081"],
    [
      "cross-env wrapping expo start",
      "node /x/node_modules/.bin/cross-env APP_VARIANT=development expo start --port 8081",
    ],
    ["expo export", "node /x/node_modules/.bin/expo export --platform web"],
    ["a shell mentioning expo start", "/bin/zsh -c cd /x && npx expo start"],
    ["an editor on the expo bin", "vim /x/node_modules/.bin/expo start"],
    ["react-native run-android", "node /x/node_modules/react-native/cli.js run-android"],
    ["a JVM with a lookalike main class", "java -cp x.jar com.example.GradleDaemonHelper"],
    ["rg for the Kotlin daemon", "rg --files-with-matches KotlinCompileDaemon /Users/t/src"],
  ])("rejects %s", (_name, command) => {
    expect(matchBuildDaemonSignature(command)).toBeUndefined();
  });
});

describe("isOrphanBuildDaemonCommand", () => {
  test("counts every allowlisted kind", () => {
    for (const command of [
      VBCSCOMPILER_APPHOST,
      MSBUILD_NODE,
      RAZOR_SERVER,
      KOTLIN_DAEMON,
      EXPO_METRO,
    ]) {
      expect(isOrphanBuildDaemonCommand(command)).toBe(true);
    }
  });

  test("still counts a process that only carries a build-daemon name, as the marker list always has", () => {
    expect(isOrphanBuildDaemonCommand("grep VBCSCompiler")).toBe(true);
    expect(isOrphanBuildDaemonCommand("some-launcher GradleDaemon")).toBe(true);
  });

  test("does not count a Metro-lookalike or an MSBuild client", () => {
    expect(isOrphanBuildDaemonCommand("node /x/.bin/cross-env FOO=1 expo start")).toBe(false);
    expect(isOrphanBuildDaemonCommand(DOTNET_BUILD_CLIENT)).toBe(false);
  });
});
