import * as os from "os";
import * as path from "path";

/**
 * Mirrors the daemon's own `PASEO_HOME` resolution
 * (`packages/server/src/server/paseo-home.ts`) without importing daemon-only
 * code into the plugin bundle: the plugin runs as its own esbuild/eval
 * subprocess (docs/jev.md, "Where it lives"), but it inherits the daemon's
 * environment (`pluginChildEnv`/`createPaseoInternalEnv`), `PASEO_HOME`
 * included, so reading `env.PASEO_HOME` here always agrees with the daemon.
 */
export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw === "~" ? os.homedir() : raw;
  return path.resolve(expanded);
}
