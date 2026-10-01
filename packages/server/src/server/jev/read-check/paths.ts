import path from "node:path";

/**
 * Which files the read check never sends (docs/jev.md, "When JEV is asked", rule 3): a file
 * outside the agent's cwd, under a denied root, or with a secret-shaped name.
 *
 * The rules are the JEV file tools' (`agent/tools/jev-file-state.ts` on the tools track, not yet
 * merged when this was written). When that module lands, import `isSecretShapedPath` and its
 * denied roots from it and delete the copies here, so both features refuse the same files.
 */

const SECRET_NAME_RES = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|p8|jks|keystore|mobileprovision|tfvars)$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^credentials/i,
  /^\.credentials/i,
  /^hosts\.yml$/i,
  /^kubeconfig$/i,
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  /^local\.properties$/i,
  /^keystore\.properties$/i,
];

export function isSecretShapedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (SECRET_NAME_RES.some((re) => re.test(base))) return true;
  const parent = path.posix.basename(path.posix.dirname(normalized));
  return base.toLowerCase() === "config.json" && parent.toLowerCase() === ".docker";
}

/** Roots no file is sent from, even inside an agent's cwd: credentials and Paseo's own state. */
export function readCheckDeniedRoots(input: { homeDir: string; paseoHome: string }): string[] {
  return [
    input.paseoHome,
    ...[".config", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "Library"].map((name) =>
      path.join(input.homeDir, name),
    ),
  ];
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
