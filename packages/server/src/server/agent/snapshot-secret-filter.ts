/**
 * Whether an untracked file might hold a secret, so a work snapshot leaves it out. See
 * docs/work-snapshots.md.
 *
 * It errs toward leaving a file out: a file left out stays on disk and is named in the snapshot's
 * commit message, while a secret in a pushed snapshot cannot be taken back.
 */

import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";

/** How much of a file is scanned for a token. */
const CONTENT_SCAN_BYTES = 64 * 1024;

const ENV_TEMPLATE_SUFFIX = /[._-](?:example|sample|template)$/;

/** Tested against the whole lower-cased relative path. */
const SECRET_DIRECTORY =
  /(?:^|\/)(?:\.?(?:secrets?|credentials?)|\.(?:aws|ssh|gnupg|kube|docker))\//;

const SECRET_NAMES: readonly RegExp[] = [
  /secret/,
  /credential/,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/,
  /^[._](?:netrc|npmrc|pypirc|pgpass)$/,
  /^\.htpasswd$/,
  /^kubeconfig/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/,
];

// Tested against the name without its last extension: `token.txt` and `db_password` count,
// `token-burn.ts`, `useToken.ts` and `ResetPassword.tsx` do not.
const SECRET_STEM =
  /(?:^|[._-])(?:(?:access|auth|api|bearer|refresh)[_-]?)?token$|(?:^|[._-])api[_-]?keys?$|(?:^|[._-])passw(?:or)?ds?$/;

// A left boundary on each prefix, so `task-…` or `disk-…` is not read as an `sk-` key.
const TOKENS: readonly { kind: string; pattern: RegExp }[] = [
  {
    kind: "Anthropic or OpenAI key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{8,}/,
  },
  { kind: "OpenAI key", pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/ },
  { kind: "Stripe key", pattern: /(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{20,}/ },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9_])gh[opsur]_[A-Za-z0-9]{20,}/ },
  { kind: "GitHub token", pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "GitLab token", pattern: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/ },
  { kind: "Hugging Face token", pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/ },
  { kind: "npm token", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/ },
  { kind: "Slack token", pattern: /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    kind: "Slack webhook",
    pattern: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
  },
  { kind: "AWS access key", pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/ },
  { kind: "Google API key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/ },
  { kind: "Notion token", pattern: /(?<![A-Za-z0-9_])ntn_[A-Za-z0-9]{20,}/ },
  { kind: "Notion token", pattern: /(?<![A-Za-z0-9_])secret_[A-Za-z0-9]{43}(?![A-Za-z0-9])/ },
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  {
    kind: "URL with a password",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/@]+:[^\s/@]+@/,
  },
];

/** What stands in for a path that is itself token-shaped wherever a path is written down. */
export const WITHHELD_PATH = "<path withheld: looks like a token>";

export function hasSecretName(path: string): boolean {
  const lowered = path.toLowerCase();
  if (SECRET_DIRECTORY.test(lowered)) return true;
  const name = basename(lowered);
  if (name === ".envrc" || name.endsWith(".env")) return true;
  if (/^\.env[._-]/.test(name)) return !ENV_TEMPLATE_SUFFIX.test(name);
  if (SECRET_NAMES.some((pattern) => pattern.test(name))) return true;
  return SECRET_STEM.test(name.replace(/(?<=.)\.[^.]*$/, ""));
}

/**
 * The kind of the first token in `text`, or null. NULs are dropped first, so a token saved as
 * UTF-16 is found too.
 */
export function findTokenKind(text: string): string | null {
  const scanned = text.includes("\0") ? text.replaceAll("\0", "") : text;
  return TOKENS.find(({ pattern }) => pattern.test(scanned))?.kind ?? null;
}

/** `path`, or `WITHHELD_PATH` when the path itself holds a token. */
export function displayPath(path: string): string {
  return findTokenKind(path) === null ? path : WITHHELD_PATH;
}

/**
 * True when any holds: a secret-shaped name or directory, a token in the path, a mode with no
 * group or other bits (someone made it owner-only on purpose), or a token in its first 64 KB. A
 * symlink is judged by path only: git stores its target, not what it points at. A file that
 * cannot be read counts as a secret.
 */
export async function looksLikeSecret(
  absolutePath: string,
  relativePath: string,
  stats: Stats,
): Promise<boolean> {
  if (hasSecretName(relativePath) || findTokenKind(relativePath) !== null) return true;
  if (stats.isSymbolicLink()) return false;
  if ((stats.mode & 0o077) === 0) return true;
  if (!stats.isFile()) return false;
  const head = await readHead(absolutePath);
  return head === null || findTokenKind(head) !== null;
}

async function readHead(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(CONTENT_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CONTENT_SCAN_BYTES, 0);
    return buffer.toString("latin1", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
