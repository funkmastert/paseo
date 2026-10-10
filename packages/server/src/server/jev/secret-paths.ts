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

/** A glob's `*` matches any run of characters within one path segment, dots included, as in git. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`(^|/)${body}$`, "i");
}

const SECRET_NAME_RES = SECRET_PATHSPEC_GLOBS.map(globToRegExp);

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

/**
 * A path as the secret rules compare it. Compatibility forms fold (`．env` is `.env`), lookalike
 * letters become ASCII, and each segment loses what Windows drops when it opens a file: trailing
 * dots and spaces, and an `:stream` suffix (`.env::$DATA`). On macOS and Linux those are distinct
 * files, but a name built to look like a secret one is refused there too.
 *
 * Exported for reuse by codex-guard.ts's file-change sensitivity check (docs/jev.md Feature 16
 * step 7 names this spot as the canonical normalization): the same NTFS aliasing -- a trailing
 * dot/space or a `:stream` suffix -- that can hide a secret file from this module's own regexes
 * can equally hide `.git`/`.ssh`/a shell rc file from that one's sensitive-path check, so both
 * normalize the same way rather than keeping two copies that could drift.
 */
export function comparableName(filePath: string): string {
  const folded = filePath.normalize("NFKC").replace(LOOKALIKE_RE, (letter) => LOOKALIKES[letter]!);
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
