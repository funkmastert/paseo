/**
 * Whether a GitHub repository is private, for the work snapshot's push. See
 * docs/work-snapshots.md.
 *
 * Only a definite `private` allows the push. `public` and `unknown` both bundle, so a timeout, a
 * rate limit or a missing `gh` never sends a snapshot somewhere anyone can read it.
 */

import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";

export type RepoVisibility = "public" | "private" | "unknown";

const LOOKUP_TIMEOUT_MS = 10_000;
/** What GitHub allows in an owner or repository name. Anything else never reaches a URL. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export interface GitHubVisibilityDependencies {
  /** `gh`'s stdout, or null when `gh` is not installed. Throws when `gh` fails. */
  runGh: (args: string[], timeoutMs: number) => Promise<string | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const defaultDependencies: GitHubVisibilityDependencies = {
  runGh: async (args, timeoutMs) => {
    const ghPath = await findExecutable("gh");
    if (!ghPath) return null;
    const result = await execCommand(ghPath, args, {
      envOverlay: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeout: timeoutMs,
    });
    return String(result.stdout);
  },
  fetch: (url, init) => fetch(url, init),
};

/** `{ owner, repo }` of a GitHub remote URL, or null when `url` is not one. */
export function parseGitHubRepository(url: string): { owner: string; repo: string } | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Asks `gh` first, which sees Tyler's private repositories. Without a definite answer from it,
 * asks the API anonymously: a 404 is private or missing, and a push to a missing repository fails
 * and falls back to a bundle anyway.
 */
export async function lookupGitHubRepoVisibility(
  owner: string,
  repo: string,
  dependencies: GitHubVisibilityDependencies = defaultDependencies,
): Promise<RepoVisibility> {
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return "unknown";
  try {
    const answer = (
      await dependencies.runGh(
        ["api", `repos/${owner}/${repo}`, "--jq", ".private"],
        LOOKUP_TIMEOUT_MS,
      )
    )?.trim();
    if (answer === "true") return "private";
    if (answer === "false") return "public";
  } catch {
    // Not signed in, no access, or a timeout: the anonymous API still answers for a public repo.
  }
  try {
    const response = await dependencies.fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "paseo-work-snapshot" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (response.status === 404) return "private";
    if (response.status !== 200) return "unknown";
    const body: unknown = await response.json();
    const flag =
      typeof body === "object" && body !== null ? (body as { private?: unknown }).private : null;
    if (flag === true) return "private";
    if (flag === false) return "public";
    return "unknown";
  } catch {
    return "unknown";
  }
}
