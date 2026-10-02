import path from "node:path";

/**
 * Which files the read check never sends (docs/jev.md, "When JEV is asked", rule 3), apart from
 * the secret-shaped names in `../secret-paths.ts`: a file in a personal location, whatever the
 * agent's cwd. The observer also requires the file to be inside the agent's cwd and inside a git
 * work tree below the home directory; everything else is refused by default.
 */

/** Directories directly under the home directory that hold a person's own files, not a project's. */
const PERSONAL_HOME_DIRS = [
  "Documents",
  "Desktop",
  "Downloads",
  "Library",
  "Pictures",
  "Movies",
  "Music",
  "Videos",
  "AppData",
  "OneDrive",
  "Dropbox",
];

export interface PersonalPathRules {
  /** The home directory as configured and as realpath spells it; both are checked. */
  homeDirs: string[];
  paseoHome: string;
  platform: NodeJS.Platform;
}

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** `child` relative to `parent`, or null when it is not at or below it. Case-folded where the volume folds. */
function relativeBelow(child: string, parent: string, platform: NodeJS.Platform): string[] | null {
  const fold = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
  const relative = path.relative(fold(parent), fold(child));
  if (relative === "") return [];
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(/[\\/]/);
}

/**
 * A personal location: Paseo's own state; any dot-entry directly under the home directory
 * (`~/.zsh_history`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude*`, `~/.claude.json`, browser
 * and mail profiles on Linux); or `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library` (mail,
 * Messages, browser profiles on macOS), `~/AppData` and the like.
 */
export function isPersonalPath(candidate: string, rules: PersonalPathRules): boolean {
  if (relativeBelow(candidate, rules.paseoHome, rules.platform) !== null) return true;
  const personal = new Set(
    PERSONAL_HOME_DIRS.map((name) => (foldsCase(rules.platform) ? name.toLowerCase() : name)),
  );
  return rules.homeDirs.some((home) => {
    const segments = relativeBelow(candidate, home, rules.platform);
    const first = segments?.[0];
    if (first === undefined) return false;
    return first.startsWith(".") || personal.has(first);
  });
}

/** Whether `candidate` is the home directory or one of its ancestors. */
export function isHomeOrAbove(candidate: string, rules: PersonalPathRules): boolean {
  return rules.homeDirs.some((home) => relativeBelow(home, candidate, rules.platform) !== null);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
