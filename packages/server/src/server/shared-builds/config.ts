/**
 * `agents.sharedBuilds` (docs/shared-builds.md). Read from `config.json` on every share and sweep,
 * so a change applies without a restart. The public base URL is the configured `app.baseUrl`: the
 * same static site serves the web UI and the shared builds.
 */

const MEBIBYTE = 1024 * 1024;

export interface ResolvedSharedBuildsConfig {
  enabled: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  expiryMs: number;
  /** `app.baseUrl` without a trailing slash, or null when it is unset or not https. */
  publicBaseUrl: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** An https URL with no query or fragment, without its trailing slash; anything else is null. */
function httpsBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, "");
}

/** The whole parsed `config.json`: the section is `agents.sharedBuilds`, the URL `app.baseUrl`. */
export function resolveSharedBuildsConfig(
  rawConfig: Record<string, unknown> | null,
): ResolvedSharedBuildsConfig {
  const section = record(record(rawConfig?.["agents"])["sharedBuilds"]);
  return {
    enabled: section["enabled"] !== false,
    maxFileBytes: positive(section["maxFileMb"], 600) * MEBIBYTE,
    maxTotalBytes: positive(section["maxTotalMb"], 3072) * MEBIBYTE,
    expiryMs: positive(section["expiryHours"], 72) * 60 * 60 * 1000,
    publicBaseUrl: httpsBaseUrl(record(rawConfig?.["app"])["baseUrl"]),
  };
}
