#!/usr/bin/env node
// Guards against node_modules/@getpaseo/plugin silently degrading from the
// dev symlink (packages/plugin build, in the fork) to the published 0.8.0
// package. 0.8.0 predates role-labels/initialPrompt support on
// PluginBeforeRequests["agent.create"], so a plain `npm install` replacing
// the symlink leaves the role router inert with a clean typecheck — no
// error, just every request routed as if no role/type label was ever
// declared. Run before test/typecheck so that degradation fails loudly
// instead of silently. Dependency-free: only node's own fs/module/path.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const RELINK_COMMAND =
  "ln -sfn /Users/tylerthackray/.paseo/worktrees/3jvw4yw6/scrawny-goat/packages/plugin node_modules/@getpaseo/plugin";

function fail(message) {
  console.error(`[claude-account-pool] ${message}\nRe-link the dev build:\n  ${RELINK_COMMAND}`);
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
