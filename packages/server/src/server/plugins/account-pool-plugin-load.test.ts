import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { compilePlugin } from "./compiler.js";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";

/**
 * Does the bundled claude-account-pool plugin actually LOAD?
 *
 * Its own 538 unit tests import TypeScript modules through vitest, which is
 * nothing like how the daemon runs it: `plugin-process.ts` compiles the plugin
 * to a single CJS bundle with esbuild and evaluates that string with
 * `globalThis.eval`. Module-scope code that works under vitest can throw
 * there, and when it does the whole plugin fails to load — taking account
 * routing, model policy and tool enforcement down with it, with a message
 * ("Invalid URL") that names nothing.
 *
 * That is not hypothetical: it shipped. `import.meta.url` is the trap.
 * esbuild has no module URL to give a CJS bundle, so it emits
 * `var import_meta = {}` and `import_meta.url` is `undefined`; a top-level
 * `new URL("./x", import.meta.url)` then throws `TypeError: Invalid URL`
 * while the bundle is being evaluated — before `contribute()` is ever called,
 * so no feature flag can guard it.
 *
 * This suite reproduces that load path exactly and asserts the plugin
 * survives it. It is deliberately NOT one of the `.local.e2e` suites: those
 * need a plugin checked out elsewhere on disk and never run in CI, whereas
 * this plugin lives in this repo and its loadability is not optional.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PLUGIN_ENTRY = path.join(REPO_ROOT, "plugins", "claude-account-pool", "index.server.ts");

/**
 * `runtimeRequire` and the eval, copied in shape from plugin-process.ts. If
 * that file's loading contract changes, this should be updated to match — the
 * point is to run the plugin the way the daemon does, not a friendlier way.
 */
function loadServerBundle(bundle: string): { default?: unknown } {
  const nodeRequire = createRequire(fileURLToPath(new URL("./plugin-process.ts", import.meta.url)));
  const runtimeRequire = (name: string): unknown => {
    if (isPluginClientOnlySdkSpecifier(name)) {
      throw new Error(`${name} is available only in plugin client code`);
    }
    if (name === "@getpaseo/plugin") return pluginSharedRuntime;
    if (name === "@getpaseo/plugin/server") return {};
    return nodeRequire(name);
  };
  // Indirect eval, exactly as plugin-process.ts does it: the bundle runs in
  // global scope, where module-scope conveniences like `__filename` and
  // `import.meta` do not exist.
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle) as (require: (name: string) => unknown) => { default?: unknown };
  expect(typeof factory).toBe("function");
  return factory(runtimeRequire);
}

describe("claude-account-pool loads the way the daemon loads it", () => {
  it("compiles, evaluates and contributes without throwing", async () => {
    const { serverBundle } = await compilePlugin({ client: null, server: PLUGIN_ENTRY });
    expect(serverBundle).toBeTruthy();

    // Evaluating the bundle runs every module-scope statement in the plugin.
    // This is the step that threw `Invalid URL` in production.
    const exports = loadServerBundle(serverBundle as string);
    expect(typeof exports.default).toBe("function");

    // And contribute() itself must run and hand back a cleanup function —
    // registering hooks and RPCs against a minimal server context, with no
    // daemon behind it. Nothing here should need one: every capability the
    // plugin builds is lazy until a hook fires.
    const registeredHooks: string[] = [];
    const cleanup = (exports.default as (server: unknown) => unknown)({
      handle: () => () => {},
      registerProvider: () => () => {},
      registerSettings: () => () => {},
      on: (event: string) => {
        registeredHooks.push(`on:${event}`);
        return () => {};
      },
      before: (event: string) => {
        registeredHooks.push(`before:${event}`);
        return () => {};
      },
    });

    expect(registeredHooks).toContain("before:agent.create");
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
  }, 120_000);

  /**
   * The narrower assertion, kept separate so a failure says WHY rather than
   * just "the plugin didn't load". esbuild emits `var import_meta = {}` for a
   * CJS bundle, so any `import.meta.url` reaching the bundle is `undefined` —
   * harmless if nothing dereferences it, fatal the moment something passes it
   * to `new URL()` or `fileURLToPath()`.
   */
  it("never passes import.meta.url to a URL constructor", async () => {
    const { serverBundle } = await compilePlugin({ client: null, server: PLUGIN_ENTRY });
    const bundle = serverBundle as string;

    // esbuild names the shim `import_meta` (or `import_meta2`, … when a name
    // is taken). Any use of `.url` off one of those is the bug.
    const dereferences = bundle.match(/\bimport_meta\w*\.url\b/g) ?? [];
    expect(dereferences).toEqual([]);
  }, 120_000);
});
