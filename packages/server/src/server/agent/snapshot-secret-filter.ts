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

const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template)$/;

const SECRET_NAMES: readonly RegExp[] = [
  /secret/,
  /credential/,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/,
  /^[._](?:netrc|npmrc|pypirc)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/,
];

// A left boundary on each prefix, so `task-…` or `disk-…` is not read as an `sk-` key.
const TOKENS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-(?:ant|proj)-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9_])gh[opsur]_[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/,
  /(?<![A-Za-z0-9_])ntn_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
];

export function hasSecretName(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || name === ".envrc") return true;
  if (name.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIX.test(name);
  return SECRET_NAMES.some((pattern) => pattern.test(name));
}

/**
 * True when any holds: a secret-shaped name, a mode with no group or other bits (someone made it
 * owner-only on purpose), or a token in its first 64 KB. A symlink is judged by name only: git
 * stores its target, not what it points at. A file that cannot be read counts as a secret.
 */
export async function looksLikeSecret(
  absolutePath: string,
  relativePath: string,
  stats: Stats,
): Promise<boolean> {
  if (hasSecretName(relativePath)) return true;
  if (stats.isSymbolicLink()) return false;
  if ((stats.mode & 0o077) === 0) return true;
  if (!stats.isFile()) return false;
  const head = await readHead(absolutePath);
  return head === null || TOKENS.some((pattern) => pattern.test(head));
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
