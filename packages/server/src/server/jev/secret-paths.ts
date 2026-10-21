/**
 * Secret-shaped file names (docs/jev.md, "Reading files safely"): the one list every JEV feature
 * that might send a file refuses. The read check (feature 16) and the JEV file tools (features
 * 4–6, `agent/tools/jev-file-state.ts`) both import it, so they refuse the same files. The agent
 * can still read any of them; JEV only declines to send them to a third party.
 *
 * The globs also feed `git diff`'s `:(exclude,glob,icase)` pathspecs in the tools, so a diff
 * leaves out exactly what a read refuses. Matched case-insensitively both ways: macOS and Windows
 * volumes fold case, and `Credentials.json` is the same secret as `credentials.json`.
 */
export const SECRET_PATHSPEC_GLOBS = [
  ".env",
  ".env.*",
  "*.env",
  ".envrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.p8",
  "*.ppk",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.mobileprovision",
  "*.tfvars",
  "*.tfstate",
  "*.tfstate.*",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".vault-token",
  "credentials*",
  ".credentials*",
  "secrets.y*ml",
  "service-account*.json",
  "hosts.yml",
  "kubeconfig",
  ".docker/config.json",
  "google-services.json",
  "GoogleService-Info.plist",
  "local.properties",
  "keystore.properties",
  // Shell, REPL and database client histories: `.zsh_history`, `.psql_history`, `.node_repl_history`.
  "*_history",
  // Local secret files with ordinary names: Cloudflare's `.dev.vars`, VPN profiles, PHP and web
  // server credentials, package-manager and cloud CLI configs, service-account key JSON.
  ".dev.vars",
  ".dev.vars.*",
  "env.local",
  "dotenv",
  "secrets.json",
  "*.secret",
  "*.ovpn",
  ".htpasswd",
  "wp-config.php",
  "firebase-adminsdk*.json",
  "*service-account*.json",
  "*serviceaccount*.json",
  "gcp-*.json",
  "*-sa-key.json",
  ".yarnrc.yml",
  ".terraformrc",
  "terraform.rc",
  ".s3cfg",
  ".my.cnf",
  ".boto",
  "auth.json",
] as const;

/**
 * A glob's `*` matches any run of characters within one path segment, dots included, as in git.
 * Exported for `agent/workspace-sweep-detector.ts`'s `regenerableIgnoredPaths` matcher, which
 * needs the same glob semantics with a different flag (`"u"`, case-sensitive, instead of this
 * module's own case-insensitive `"i"`) rather than a second copy of the escape-and-join logic.
 *
 * `matchChildren` is for a pattern naming a directory (`agent/backup-eligible-ignored.ts`'s
 * `backupIgnoredPaths`): it also matches anything git lists individually underneath that
 * directory, not just the directory path itself.
 */
export function globToRegExp(
  glob: string,
  flags = "i",
  options: { matchChildren?: boolean } = {},
): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const tail = options.matchChildren ? "(?:/.*)?$" : "$";
  return new RegExp(`(^|/)${body}${tail}`, flags);
}

const SECRET_NAME_RES = SECRET_PATHSPEC_GLOBS.map((glob) => globToRegExp(glob));

/** Letters that render like ASCII ones (Cyrillic and Greek): `.еnv` is matched as `.env`. */
const LOOKALIKES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");

// HFS+ ignores these code points when comparing two names -- `.g‌it` (a ZERO WIDTH NON-JOINER
// after the "g") opens `.git` on an HFS+ volume, the same class of gap as git's CVE-2014-9390 /
// core.protectHFS. None has a legitimate role in a file name, so all are stripped outright,
// before any other folding -- NFKC/lookalike folding operates on code points these never were
// meant to survive as. U+200B (zero width space) is deliberately NOT on this list: HFS+ does not
// ignore it, so a name built with one is genuinely a different name on that filesystem too.
const HFS_IGNORED_CODE_POINTS = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * A path as the secret rules compare it. HFS+-ignored code points are stripped outright,
 * compatibility forms fold (`．env` is `.env`), lookalike letters become ASCII, and each segment
 * loses what Windows drops when it opens a file: trailing dots and spaces, and an `:stream`
 * suffix (`.env::$DATA`). On Linux those are distinct files, but a name built to look like a
 * secret one is refused there too.
 *
 * Exported for reuse by codex-guard.ts's file-change sensitivity check (docs/jev.md Feature 16
 * step 7 names this spot as the canonical normalization): the same aliasing -- an HFS+-ignored
 * code point, a trailing dot/space, or a `:stream` suffix -- that can hide a secret file from
 * this module's own regexes can equally hide `.git`/`.ssh`/a shell rc file from that one's
 * sensitive-path check, so both normalize the same way rather than keeping two copies that could
 * drift.
 */
export function comparableName(filePath: string): string {
  const withoutIgnoredCodePoints = filePath.replace(HFS_IGNORED_CODE_POINTS, "");
  const folded = withoutIgnoredCodePoints
    .normalize("NFKC")
    .replace(LOOKALIKE_RE, (letter) => LOOKALIKES[letter]!);
  return folded
    .replace(/\\/g, "/")
    .split("/")
    .map((segment, index) => {
      const drive = index === 0 && /^[A-Za-z]:$/.test(segment);
      const stream = drive ? segment : segment.replace(/(?<=.):.*$/, "");
      return stream === "." || stream === ".." ? stream : stream.replace(/[. ]+$/, "");
    })
    .join("/");
}

export function isSecretShapedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const comparable = comparableName(filePath);
  return SECRET_NAME_RES.some((re) => re.test(normalized) || re.test(comparable));
}

/**
 * Resolves a list of user-supplied ignored-path patterns -- a path suffix, or a simple glob with
 * `*` standing for any run of characters within one path segment -- dropping any that could
 * match a secret, whatever its extension, or that names no file at all (a last segment of only
 * wildcards). Shared by every `agents.doneJanitor` config key that lets a pattern reach a by-name
 * rule unreviewed (`regenerableIgnoredPaths`, `agent/workspace-sweep-detector.ts`;
 * `backupIgnoredPaths`, `agent/backup-eligible-ignored.ts`): the janitor's own rules are a closed,
 * reviewed list, and a pattern that could match a secret would make it delete, or back up, a
 * secret unread. A pattern is rejected when it, or a copy with every `*` turned into a literal
 * character, is itself secret-shaped. `onRejectedPattern` is called once per rejection so the
 * caller can log it.
 *
 * `allowDirectory` lets a pattern end in `/` and still name a file: the regenerable list is
 * files-only by design, but a backup-eligible pattern has to match a directory (`.worker-logs/`).
 * Without it, a trailing slash leaves no last segment and the pattern is rejected as naming no
 * file, same as `*` or `dir/*`.
 */
export function resolveIgnoredPathPatterns(
  patterns: readonly string[] | undefined,
  onRejectedPattern: (pattern: string) => void,
  options: { allowDirectory?: boolean } = {},
): string[] {
  if (!patterns || patterns.length === 0) return [];
  const accepted: string[] = [];
  for (const pattern of patterns) {
    const sample = pattern.replace(/\*/gu, "x");
    const trimmed = options.allowDirectory ? pattern.trim().replace(/\/$/u, "") : pattern.trim();
    const trimmedSample = trimmed.replace(/\*/gu, "x");
    const lastSegment = trimmed.split("/").pop() ?? "";
    if (
      lastSegment.replace(/\*/gu, "") === "" ||
      isSecretShapedPath(pattern) ||
      isSecretShapedPath(sample) ||
      isSecretShapedPath(trimmed) ||
      isSecretShapedPath(trimmedSample)
    ) {
      onRejectedPattern(pattern);
      continue;
    }
    accepted.push(pattern);
  }
  return accepted;
}
