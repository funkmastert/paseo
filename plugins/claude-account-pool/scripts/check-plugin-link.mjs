#!/usr/bin/env node
// Guards against @getpaseo/plugin silently degrading from this workspace's
// own dev build (packages/plugin, linked automatically by npm workspaces
// since this plugin was vendored into the fork at plugins/claude-account-pool)
// to the published 0.8.0 package. 0.8.0 predates role-labels/initialPrompt
// support on PluginBeforeRequests["agent.create"], so losing the workspace
// link leaves the role router inert with a clean typecheck — no error, just
// every request routed as if no role/type label was ever declared. Run
// before test/typecheck so that degradation fails loudly instead of
// silently. Dependency-free: only node's own fs/module/path.
//
// CI runs this only in the ubuntu `plugin-tests` job (through the plugin's
// pretest/pretypecheck); server-tests-windows never reaches it. It is
// platform-neutral anyway: require.resolve returns the real path of the
// workspace link (a junction on Windows) and every path here goes through
// node:path, which is separator-aware on both platforms.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const RELINK_COMMAND = "npm install (from the fork root, paseo-worktrees/bozeo or your checkout)";

function fail(message) {
  console.error(`[claude-account-pool] ${message}\nRestore the workspace link:\n  ${RELINK_COMMAND}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);

// "@getpaseo/plugin/server" is the one subpath this plugin actually imports
// from; its exports entry resolves to .../dist/server/index.js. The
// package's own "./package.json" subpath isn't declared in its exports map,
// so resolve through a subpath the package does expose instead.
let serverEntryPath;
try {
  serverEntryPath = require.resolve("@getpaseo/plugin/server");
} catch (error) {
  fail(`@getpaseo/plugin did not resolve at all (${error.message}).`);
}

const pkgDir = dirname(dirname(dirname(serverEntryPath))); // dist/server/index.js -> package root
const lifecycleDtsPath = join(pkgDir, "dist", "server", "lifecycle.d.ts");

let source;
try {
  source = readFileSync(lifecycleDtsPath, "utf8");
} catch (error) {
  fail(`server lifecycle typings not found at ${lifecycleDtsPath} (${error.message}).`);
}

if (!source.includes("initialPrompt")) {
  fail(
    `@getpaseo/plugin resolved to a build without \`initialPrompt\` (server lifecycle typings at ${lifecycleDtsPath} don't mention it) — looks like the dev symlink was replaced by a published install.`,
  );
}

console.log("[claude-account-pool] @getpaseo/plugin dev link OK (initialPrompt present).");
