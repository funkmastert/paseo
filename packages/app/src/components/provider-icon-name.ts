import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
} from "@getpaseo/protocol/provider-icon-names";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "catalog"; id: string }
  | { kind: "svg"; svg: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set(BUILTIN_PROVIDER_ICON_NAMES);
const KNOWN_PROVIDER_IDS = new Set(KNOWN_PROVIDER_ICON_NAMES);

interface ProviderSnapshotIconInfo {
  iconSvg?: string;
  derivedFromProviderId?: string | null;
}

const providerSnapshotIconsByServer = new Map<
  string,
  ReadonlyMap<string, ProviderSnapshotIconInfo>
>();

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg" | "derivedFromProviderId">[],
): void {
  const icons = new Map<string, ProviderSnapshotIconInfo>();
  for (const entry of entries) {
    if (entry.iconSvg || entry.derivedFromProviderId) {
      icons.set(entry.provider, {
        iconSvg: entry.iconSvg,
        derivedFromProviderId: entry.derivedFromProviderId,
      });
    }
  }
  providerSnapshotIconsByServer.set(serverId, icons);
}

export function resolveProviderIconName(
  provider: string,
  serverId?: string | null,
): ProviderIconName {
  if (BUILTIN_PROVIDER_IDS.has(provider)) {
    return { kind: "builtin", id: provider };
  }
  const info = serverId ? providerSnapshotIconsByServer.get(serverId)?.get(provider) : undefined;
  if (info?.iconSvg) {
    return { kind: "svg", svg: info.iconSvg };
  }
  if (KNOWN_PROVIDER_IDS.has(provider)) {
    return { kind: "catalog", id: provider };
  }
  // A custom entry that extends a known provider (e.g. a claude-account-pool
  // entry extending "claude") renders the base provider's icon rather than
  // falling back to the generic bot icon.
  const derivedFromProviderId = info?.derivedFromProviderId;
  if (derivedFromProviderId && BUILTIN_PROVIDER_IDS.has(derivedFromProviderId)) {
    return { kind: "builtin", id: derivedFromProviderId };
  }
  if (derivedFromProviderId && KNOWN_PROVIDER_IDS.has(derivedFromProviderId)) {
    return { kind: "catalog", id: derivedFromProviderId };
  }
  return { kind: "bot" };
}
