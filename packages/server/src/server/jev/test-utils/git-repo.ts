import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * A real git work tree at `directory`. The read check asks git whether a file is ignored, and a
 * bare `.git` directory is not a repository, so such a file would be refused.
 */
export function initGitRepo(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  execFileSync("git", ["init", "-q", directory], { env, stdio: "ignore" });
}
