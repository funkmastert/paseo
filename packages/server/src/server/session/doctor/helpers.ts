import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";

export function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

export function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

export function readlinkOrNull(target: string): string | null {
  try {
    return readlinkSync(target);
  } catch {
    return null;
  }
}

/** `~`, `~/x`, `$VAR` and `${VAR}` expansion, the way a provider's `env` values are read. */
export function expandPathLike(value: string, home: string, env: NodeJS.ProcessEnv): string {
  let out = value;
  if (out === "~") out = home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(home, out.slice(2));
  return out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = (a ?? b) as string;
    return name === "HOME" ? home : (env[name] ?? "");
  });
}

function quote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value}"`;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that makes `link` point at `target`. Doctor prints it; it never runs it. */
export function linkCommand(
  target: string,
  link: string,
  options: { directory: boolean; platform: NodeJS.Platform },
): string {
  const { platform } = options;
  if (platform === "win32") {
    return `mklink ${options.directory ? "/D " : ""}${quote(link, platform)} ${quote(target, platform)}`;
  }
  return `ln -s ${quote(target, platform)} ${quote(link, platform)}`;
}

export function moveAsideCommand(from: string, to: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `move ${quote(from, platform)} ${quote(to, platform)}`
    : `mv ${quote(from, platform)} ${quote(to, platform)}`;
}

export function joinCommands(commands: string[], platform: NodeJS.Platform): string {
  return commands.join(platform === "win32" ? " & " : " && ");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
