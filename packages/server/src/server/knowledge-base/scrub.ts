/**
 * Secrets scrubbing for the knowledge base's single write path (KTD-10). A URL loses its userinfo
 * and any secret-shaped query parameter, and is dropped entirely if a token still remains in it. Free
 * text has every token-shaped span replaced with `[redacted]`, reusing the token patterns from
 * `agent/snapshot-secret-filter.ts` so the two scrubbers never drift apart.
 */

import { TOKENS } from "../agent/snapshot-secret-filter.js";

const SECRET_PARAM_NAME = /^(?:token|key|secret|sig(?:nature)?|password|auth|code)$/i;
const AWS_PARAM_PREFIX = /^x-amz-/i;

// `TOKENS` carries no `g` flag (each is tested with `.test()`, once); scrubbing free text needs
// replace-all, so each pattern is cloned here with `g` added.
const GLOBAL_TOKEN_PATTERNS: readonly RegExp[] = TOKENS.map(
  ({ pattern }) =>
    new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
);

function isSecretParamName(name: string): boolean {
  return SECRET_PARAM_NAME.test(name) || AWS_PARAM_PREFIX.test(name);
}

function hasToken(text: string): boolean {
  return TOKENS.some(({ pattern }) => pattern.test(text));
}

/**
 * `url` with its userinfo and secret-shaped query params removed, or `null` if a token remains
 * (in the path, say) even after that — such a URL is dropped rather than filed half-scrubbed.
 */
export function scrubUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return hasToken(url) ? null : url;
  }
  parsed.username = "";
  parsed.password = "";
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (isSecretParamName(name)) parsed.searchParams.delete(name);
  }
  const result = parsed.toString();
  return hasToken(result) ? null : result;
}

export interface ScrubTextResult {
  text: string;
  /** How many token-shaped spans were replaced, across every pattern. */
  removed: number;
}

export function scrubText(text: string): ScrubTextResult {
  let removed = 0;
  let result = text;
  for (const pattern of GLOBAL_TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      removed += 1;
      return "[redacted]";
    });
  }
  return { text: result, removed };
}
