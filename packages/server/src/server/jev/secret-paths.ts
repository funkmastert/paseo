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

export function isSecretShapedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return SECRET_NAME_RES.some((re) => re.test(normalized));
}
