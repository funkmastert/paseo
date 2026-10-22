export type ExplorerTab = "changes" | "files" | "pr" | "prs";

export function isExplorerTab(value: unknown): value is ExplorerTab {
  return value === "changes" || value === "files" || value === "pr" || value === "prs";
}

/** A stored `"pr"` (the single-PR tab this feature replaces) maps forward to `"prs"` so an old
 * persisted value still resolves to a real tab. See docs/pull-request-ledger.md. */
export function migrateExplorerTab(tab: ExplorerTab): ExplorerTab {
  return tab === "pr" ? "prs" : tab;
}

export function buildExplorerCheckoutKey(serverId: string, cwd: string): string | null {
  const trimmedServerId = serverId.trim();
  const trimmedCwd = cwd.trim();
  if (!trimmedServerId || !trimmedCwd) {
    return null;
  }
  return `${trimmedServerId}::${trimmedCwd}`;
}

export function coerceExplorerTabForCheckout(tab: ExplorerTab, isGit: boolean): ExplorerTab {
  if (!isGit && tab === "changes") {
    return "files";
  }
  return tab;
}

export function resolveExplorerTabForCheckout(params: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}): ExplorerTab {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  const stored = key ? params.explorerTabByCheckout[key] : null;
  const defaultTab: ExplorerTab = params.isGit ? "changes" : "files";
  const nextTab = stored && isExplorerTab(stored) ? migrateExplorerTab(stored) : defaultTab;
  return coerceExplorerTabForCheckout(nextTab, params.isGit);
}
