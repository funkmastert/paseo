import { defineConfig, configDefaults } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import path from "path";
import fs from "fs";

const appNodeModules = path.resolve(__dirname, "node_modules");
const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "e2e/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.{test,spec}.{ts,tsx}", "native-release-version.test.ts"],
          setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
          exclude: [...configDefaults.exclude, "e2e/**", "src/**/*.browser.{test,spec}.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          fileParallelism: false,
          include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            connectTimeout: 180_000,
            instances: [{ browser: "chromium" }],
            screenshotDirectory: ".vitest-screenshots",
          },
          globalSetup: path.resolve(__dirname, "src/runtime/websocket-test-global-setup.ts"),
        },
      },
    ],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
    maxWorkers: 2,
    server: {
      deps: {
        fallbackCJS: true,
        inline: ["zustand", "@tanstack/react-query", "react-native-web"],
      },
    },
  },
  // Reanimated ships one file per platform and picks between them by extension
  // (`findHostInstance.web.js`). Vite's dependency optimizer does not apply `resolve.extensions`,
  // so it scans the native files and dies on imports react-native-web has no answer for.
  // Unbundled, the same imports go through the resolver below and land on the web files.
  // react-native-gesture-handler (pulled in by react-native-draggable-flatlist, used by the
  // sidebar's draggable lists) hits the same scan-time failure: its non-web specs `require`
  // `react-native/Libraries/...` paths the alias below only redirects for normal, per-file
  // transforms, not the optimizer's eager scan.
  optimizeDeps: {
    // hoist-non-react-statics is gesture-handler's own CJS dependency; pre-bundling it directly
    // is what gives it a usable default export under Vite's ESM transform.
    include: ["react/jsx-runtime", "hoist-non-react-statics", "invariant"],
    // expo-asset is excluded (not pre-bundled) too: a pre-bundled dep's vi.mock in a test isn't
    // honored, since the optimizer serves a cached chunk straight to the browser.
    exclude: [
      "react-native-reanimated",
      "react-native-gesture-handler",
      "react-native-draggable-flatlist",
      "expo-asset",
    ],
  },
  // The globals a React Native bundler defines, which esbuild is no longer there to supply for
  // the package excluded above.
  define: {
    "process.env.JEST_WORKER_ID": "undefined",
    __DEV__: "false",
    global: "globalThis",
  },
  resolve: {
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
    alias: [
      {
        find: /^@getpaseo\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: /^@getpaseo\/relay$/,
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      // Must precede the `react-native` alias: a string `find` matches by prefix, so this subpath
      // would otherwise resolve inside a react-native-web *file* and break the dependency scan.
      // Reanimated only imports it on the native path, which no test takes.
      {
        find: /^react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-fabric-shim.ts"),
      },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution).
      {
        find: "react-native",
        replacement: path.resolve(__dirname, "test-stubs/react-native-web-with-toast-android.ts"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      {
        find: "react-dom",
        replacement: resolvePackageEntry("react-dom"),
      },
      {
        find: /^@xterm\/addon-ligatures\/lib\/addon-ligatures\.mjs$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^react-native-unistyles$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-unistyles.ts"),
      },
      {
        find: /^react-native-svg$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-svg.ts"),
      },
      // Both ship untranspiled Flow and fail to parse on import, which takes out any test that
      // mounts a menu surface.
      {
        find: /^react-native-safe-area-context$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-safe-area-context.ts"),
      },
      {
        find: /^@gorhom\/bottom-sheet$/,
        replacement: path.resolve(__dirname, "test-stubs/gorhom-bottom-sheet.ts"),
      },
      {
        find: /^react-native-reanimated\/scripts\/validate-worklets-version$/,
        replacement: path.resolve(__dirname, "test-stubs/reanimated-validate-worklets-version.ts"),
      },
      {
        find: /^expo-linking$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-linking.ts"),
      },
      // Ships untranspiled JSX in .js files and pulls in react-native-screens, which esbuild's
      // browser-mode dependency scan can't parse — it kills collection for every browser test
      // file, not just the ones that reach this import. Only `router` is used off this path today.
      {
        find: /^expo-router$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-router.ts"),
      },
      // Pulls in expo-modules-core, which needs `TurboModuleRegistry` off the real react-native —
      // not provided by the react-native-web stub below, so it also kills browser collection.
      {
        find: /^expo-constants$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-constants.ts"),
      },
      // Same `TurboModuleRegistry` problem as expo-constants above, reached directly by
      // src/performance/native-trace.ts.
      {
        find: /^expo-modules-core$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-modules-core.ts"),
      },
      // expo-file-system's legacy shim needs more off expo-modules-core than the stub above
      // provides, reached by src/attachments/attachment-file-system.ts.
      {
        find: /^expo-file-system\/legacy$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-file-system-legacy.ts"),
      },
      {
        find: /^expo-file-system$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-file-system.ts"),
      },
      // Ships untranspiled JSX in a .js file, which esbuild's dependency scan refuses to parse.
      {
        find: /^expo-clipboard$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-clipboard.ts"),
      },
      {
        find: /^lucide-react-native$/,
        replacement: path.resolve(__dirname, "test-stubs/lucide-react-native.ts"),
      },
    ],
  },
});
