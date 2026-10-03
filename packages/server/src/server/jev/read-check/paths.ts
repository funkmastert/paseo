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

/** Where the daemon puts an agent's checkout: `<paseoHome>/worktrees/<project>/<agent>`. */
const AGENT_WORKTREES_DIR = "worktrees";

/**
 * The two subtrees feature 16 judges in shadow forever (docs/jev.md, D12). Both sit outside every
 * agent's cwd and outside any repository, so the ordinary rules refuse them; both are what an
 * agent loads a lot of and may not need.
 */
export const SHADOW_ONLY_KINDS = ["skill-docs", "ce-scratch"] as const;
export type ShadowOnlyKind = (typeof SHADOW_ONLY_KINDS)[number];

// A plugin's skills and reference docs under `~/.claude<suffix>/plugins/cache/`, nothing else.
const PLUGIN_CACHE_SEGMENTS = ["plugins", "cache"];
const CLAUDE_CONFIG_PREFIX = ".claude";
// What the compound-engineering skills write under the temporary directory and read back.
const CE_SCRATCH_DIR = "compound-engineering";

// macOS reaches `/Users` and every other firmlinked directory through the data volume too, and
// `realpath` keeps whichever spelling it was given, so the file and the cwd can arrive spelled
// differently. `egress-scope.ts` strips the same prefix for the same reason. Folded, as darwin
// paths compare.
const DATA_VOLUME = "/system/volumes/data";

export interface PersonalPathRules {
  /** The home directory as configured and as realpath spells it; both are checked. */
  homeDirs: string[];
  /** Paseo's home as configured and as realpath spells it; both are checked. */
  paseoHomes: string[];
  /**
   * Every spelling of the temporary directory: `os.tmpdir()`, its realpath, and on macOS `/tmp`
   * and `/private/tmp`, which are the same directory through a symlink.
   */
  tmpDirs: string[];
  platform: NodeJS.Platform;
}

/**
 * Whether the platform's usual volume ignores case. A case-sensitive APFS volume is possible, and
 * there folding makes two different files compare equal; the default volume is case-insensitive,
 * where not folding makes one file compare as two. `egress-scope.ts` folds on the same platforms
 * for the same comparison, so both answers are wrong in the same places.
 */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/**
 * Only Windows reads `\` as a path separator. On macOS and Linux it is an ordinary filename
 * character, so rewriting it would make a sibling directory named `app\private` look like a child
 * of `app` and let its files through as if they were in the agent's cwd.
 */
function separators(platform: NodeJS.Platform): RegExp {
  return platform === "win32" ? /[\\/]/g : /\//g;
}

/**
 * The shape two spellings of one path compare in: NFC, one separator, case folded where the
 * volume folds, and without macOS's data-volume prefix. A rule that compares raw strings stops
 * applying the moment the two sides disagree on a spelling, which is how a private file gets
 * judged and a project file gets refused.
 */
function comparable(value: string, platform: NodeJS.Platform): string {
  const slashed = value.replace(separators(platform), "/").normalize("NFC");
  const folded = foldsCase(platform) ? slashed.toLowerCase() : slashed;
  if (platform !== "darwin") return folded;
  if (folded === DATA_VOLUME) return "/";
  return folded.startsWith(`${DATA_VOLUME}/`) ? folded.slice(DATA_VOLUME.length) : folded;
}

/** `child` relative to `parent`, or null when it is not at or below it. */
function relativeBelow(child: string, parent: string, platform: NodeJS.Platform): string[] | null {
  const relative = path.relative(comparable(parent, platform), comparable(child, platform));
  if (relative === "") return [];
  // Absolute means another volume on Windows. `path.relative` answers in the host's separator,
  // which there is `\`, so split before asking whether it climbed: a first segment that merely
  // starts with `..` is a directory named `..secret`, which is below `parent` like any other.
  if (path.isAbsolute(relative)) return null;
  const segments = relative.split(separators(platform));
  return segments[0] === ".." ? null : segments;
}

/**
 * A file inside an agent's checkout: `<paseoHome>/worktrees/<project>/<agent>/…`. That is the
 * agent's own working code, so it is judged like any other repository. The exemption has to beat
 * the home dot-entry rule as well as the Paseo-home rule, because Paseo's home is `~/.paseo`.
 *
 * Path shape is all this can tell; what carries the exemption is the rest of rule 3 in
 * docs/jev.md, which the observer applies to the same file: it must be inside the reading agent's
 * cwd, inside a git work tree, not ignored there, and not excluded by D7.
 */
function isAgentCheckout(candidate: string, paseoHome: string, platform: NodeJS.Platform): boolean {
  const segments = relativeBelow(candidate, paseoHome, platform);
  return segments !== null && segments[0] === AGENT_WORKTREES_DIR && segments.length > 3;
}

/**
 * Which shadow-only subtree this path is in, or null. Segment-based, like every other rule here:
 * `plugins/cache` carves exactly that subtree out of the Claude config dot-entry rule, so the
 * credentials, settings, history and projects beside it stay personal. Answer this for the real
 * path as well as the name, since a link inside `plugins/cache` can point anywhere.
 */
export function shadowOnlyKind(candidate: string, rules: PersonalPathRules): ShadowOnlyKind | null {
  const { platform } = rules;
  const isSkillDocs = rules.homeDirs.some((home) => {
    const segments = relativeBelow(candidate, home, platform);
    if (segments === null || segments.length <= PLUGIN_CACHE_SEGMENTS.length + 1) return false;
    const [configDir, ...rest] = segments;
    if (configDir === undefined || !configDir.startsWith(CLAUDE_CONFIG_PREFIX)) return false;
    return PLUGIN_CACHE_SEGMENTS.every((name, index) => rest[index] === name);
  });
  if (isSkillDocs) return "skill-docs";
  const isScratch = rules.tmpDirs.some((tmp) => {
    const segments = relativeBelow(candidate, tmp, platform);
    return segments !== null && segments.length > 1 && segments[0] === CE_SCRATCH_DIR;
  });
  return isScratch ? "ce-scratch" : null;
}

/**
 * A personal location: the daemon's own state under Paseo's home — config, credentials, agent
 * records, logs, the JEV directory — everything there but an agent's checkout, so a directory the
 * daemon grows later is private until someone decides otherwise; any dot-entry directly under the
 * home directory (`~/.zsh_history`, `~/.ssh`, `~/.aws`, `~/.config`, the Claude config dirs,
 * `~/.claude.json`, browser and mail profiles on Linux), apart from the plugin cache a
 * shadow-only subtree carves out of it; or `~/Documents`, `~/Desktop`, `~/Downloads`,
 * `~/Library` (mail, Messages, browser profiles on macOS), `~/AppData` and the like.
 */
export function isPersonalPath(candidate: string, rules: PersonalPathRules): boolean {
  const { paseoHomes, platform } = rules;
  if (paseoHomes.some((home) => isAgentCheckout(candidate, home, platform))) return false;
  if (paseoHomes.some((home) => relativeBelow(candidate, home, platform) !== null)) return true;
  // Checked after Paseo's home, so a shadow-only subtree can only ever relax the home dot-entry
  // rule below. If someone points `TMPDIR` inside Paseo's home, that is still daemon state.
  if (shadowOnlyKind(candidate, rules) !== null) return false;
  const personal = new Set(
    PERSONAL_HOME_DIRS.map((name) => (foldsCase(platform) ? name.toLowerCase() : name)),
  );
  return rules.homeDirs.some((home) => {
    const segments = relativeBelow(candidate, home, platform);
    const first = segments?.[0];
    if (first === undefined) return false;
    return first.startsWith(".") || personal.has(first);
  });
}

/** Whether `candidate` is the home directory or one of its ancestors. */
export function isHomeOrAbove(candidate: string, rules: PersonalPathRules): boolean {
  return rules.homeDirs.some((home) => relativeBelow(home, candidate, rules.platform) !== null);
}

/** Whether `child` is `parent` or below it, in the shape two spellings of one path compare in. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  return relativeBelow(child, parent, platform) !== null;
}
