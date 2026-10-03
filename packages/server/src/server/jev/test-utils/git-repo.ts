import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * A real git work tree at `directory`. The read check asks git whether a file is ignored, and a
 * bare `.git` directory is not a repository, so such a file would be refused. Pass `remote` to
 * give it an `origin`, which is what the D7 exclusion reads.
 */
export function initGitRepo(directory: string, options: { remote?: string } = {}): void {
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  execFileSync("git", ["init", "-q", directory], { env, stdio: "ignore" });
  if (options.remote !== undefined) {
    execFileSync("git", ["-C", directory, "remote", "add", "origin", options.remote], {
      env,
      stdio: "ignore",
    });
  }
}
