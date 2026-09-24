import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { finding, type DoctorCheck, type DoctorContext } from "./context.js";
import { formatDuration } from "./helpers.js";

/** How far past the daemon's start the bundle may be dated before it counts as newer. */
const GRACE_MS = 2 * 60_000;

interface Bundle {
  name: string;
  /** The file whose mtime says when the bundle was last replaced. */
  stamp: string;
  version: string | null;
}

function mtimeMs(target: string): number | null {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return null;
  }
}

function macBundle(appPath: string): Bundle | null {
  const stamp = path.join(appPath, "Contents", "Resources", "app.asar");
  if (mtimeMs(stamp) === null) return null;
  let version: string | null = null;
  try {
    const plist = readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    version =
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    // A binary plist or a missing one: the mtime comparison still works.
  }
  return { name: path.basename(appPath), stamp, version };
}

function winBundle(dir: string): Bundle | null {
  const stamp = path.join(dir, "resources", "app.asar");
  if (mtimeMs(stamp) === null) return null;
  return { name: path.basename(dir), stamp, version: null };
}

function candidateBundles(ctx: DoctorContext): Bundle[] {
  const { platform, env, home } = ctx;
  const found: Bundle[] = [];
  if (platform === "darwin") {
    // The bundle the daemon itself runs from wins; a stale sibling install must not stand in.
    const own = ctx.facts.daemon?.execPath && /^(.*?\.app)\//.exec(ctx.facts.daemon.execPath)?.[1];
    const apps = [
      ...(own ? [own] : []),
      "/Applications/Bozeo.app",
      path.join(home, "Applications", "Bozeo.app"),
      "/Applications/Paseo.app",
      path.join(home, "Applications", "Paseo.app"),
    ];
    for (const app of apps) {
      const bundle = macBundle(app);
      if (bundle && !found.some((b) => b.stamp === bundle.stamp)) found.push(bundle);
    }
  } else if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    for (const name of ["Bozeo", "Paseo"]) {
      const bundle = winBundle(path.join(local, "Programs", name));
      if (bundle) found.push(bundle);
    }
  }
  return found;
}

/**
 * The daemon keeps running the code it started with. A desktop update replaces the bundle on disk
 * but not the process, so fixes sat dormant for days until someone relaunched the app.
 */
export const buildCheck: DoctorCheck = {
  id: "daemon.build",
  category: "daemon",
  timeoutMs: 5_000,
  async run(ctx) {
    const daemon = ctx.facts.daemon;
    if (!daemon) {
      return [
        finding("daemon.build", "daemon", "fail", "No daemon answered", {
          detail:
            "Nothing is listening for the CLI, so nothing below that needs the daemon was checked.",
          why: "Agents are not running, and plugins, routing and monitors are all off.",
          fix: "paseo daemon start",
        }),
      ];
    }
    const started = daemon.startedAt ? Date.parse(daemon.startedAt) : Number.NaN;
    const bundles = candidateBundles(ctx);
    if (!Number.isFinite(started) || bundles.length === 0) {
      return [
        finding(
          "daemon.build",
          "daemon",
          "skip",
          "Could not compare the daemon with an app bundle",
          {
            detail: !Number.isFinite(started)
              ? "The daemon did not report when it started."
              : `No Bozeo/Paseo desktop bundle was found on ${ctx.platform}; a daemon run from source has nothing to compare with.`,
          },
        ),
      ];
    }
    const bundle = bundles[0]!;
    const bundleMs = mtimeMs(bundle.stamp)!;
    const versionDiffers = bundle.version && daemon.version && bundle.version !== daemon.version;
    if (bundleMs > started + GRACE_MS || versionDiffers) {
      const gap = bundleMs - started;
      return [
        finding("daemon.build", "daemon", "warn", `Running daemon is older than ${bundle.name}`, {
          detail: [
            `Daemon ${daemon.version ?? "?"} started ${new Date(started).toISOString()}.`,
            `${bundle.name}${bundle.version ? ` ${bundle.version}` : ""} was staged ${new Date(bundleMs).toISOString()}${gap > 0 ? `, ${formatDuration(gap)} after the daemon started` : ""}.`,
          ].join(" "),
          why: "Everything in the newer build is dormant: fixes and features do not run until the daemon restarts.",
          fix: `Relaunch ${bundle.name} (or \`paseo daemon restart\` — that ends every running agent's session, so do it when idle).`,
        }),
      ];
    }
    return [
      finding(
        "daemon.build",
        "daemon",
        "ok",
        `Daemon ${daemon.version ?? ""} is at least as new as ${bundle.name} (started ${formatDuration(ctx.now() - started)} ago)`.replace(
          "  ",
          " ",
        ),
      ),
    ];
  },
};
