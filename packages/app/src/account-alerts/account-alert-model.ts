import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveAccountLabel } from "@/orchestration/account-budget-strip-model";
import type { ProviderUsage } from "@/provider-usage/types";

export type AccountAlertKind = "signed_out" | "identity";

/** One account's sign-in or identity problem, on the host that reported it. */
export interface AccountAlertEntry {
  providerId: string;
  serverId: string;
  hostLabel: string;
  label: string;
  kind: AccountAlertKind;
  summary: string;
  fixCommand: string;
  /** Only meaningful for `signed_out`: whether the daemon resolved a binary and an email to sign in with. */
  canSignIn: boolean;
}

/** One connected host's usage rows and provider snapshot, as the banner's feed collects them. */
export interface AccountAlertHostUsage {
  serverId: string;
  hostLabel: string;
  providers: readonly ProviderUsage[];
  entries?: readonly ProviderSnapshotEntry[];
}

function isDisabled(
  entries: readonly ProviderSnapshotEntry[] | undefined,
  providerId: string,
): boolean {
  return entries?.find((entry) => entry.provider === providerId)?.enabled === false;
}

// accountAuth wins over accountIdentity on the rare row that carries both: a signed-out account
// is dead to failover regardless of which login it is signed into.
function entryFor(usage: ProviderUsage, host: AccountAlertHostUsage): AccountAlertEntry | null {
  if (isDisabled(host.entries, usage.providerId)) return null;
  const base = {
    providerId: usage.providerId,
    serverId: host.serverId,
    hostLabel: host.hostLabel,
    label: resolveAccountLabel(host.entries as ProviderSnapshotEntry[] | undefined, usage),
  };
  if (usage.accountAuth) {
    return {
      ...base,
      kind: "signed_out",
      summary: usage.accountAuth.summary,
      fixCommand: usage.accountAuth.fixCommand,
      canSignIn: usage.accountAuth.canSignIn,
    };
  }
  if (usage.accountIdentity) {
    return {
      ...base,
      kind: "identity",
      summary: usage.accountIdentity.summary,
      fixCommand: usage.accountIdentity.fixCommand,
      canSignIn: false,
    };
  }
  return null;
}

const KIND_ORDER: Readonly<Record<AccountAlertKind, number>> = { signed_out: 0, identity: 1 };

/**
 * Every enabled account across every connected host with a sign-in or identity problem:
 * signed-out first, then identity, then by account label. A disabled provider, or a row
 * carrying neither field, produces nothing.
 */
export function buildAccountAlertEntries(
  hosts: readonly AccountAlertHostUsage[],
): AccountAlertEntry[] {
  const entries: AccountAlertEntry[] = [];
  for (const host of hosts) {
    for (const usage of host.providers) {
      const entry = entryFor(usage, host);
      if (entry) entries.push(entry);
    }
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.label.localeCompare(b.label);
  });
}

/** Where the app can fix an entry from: what the desktop knows about itself and the entry's host. */
export interface SignInContext {
  isElectron: boolean;
  /** The entry's host advertises `claudeAccountSignIn`. */
  hostSupportsSignIn: boolean;
  /** The entry's host is the daemon this desktop app manages. */
  isLocalDaemon: boolean;
}

export type SignInAction = "sign_in" | "run_on_host";

/**
 * Sign in opens a browser login on the daemon's machine, so it is offered only where that machine
 * is the one in front of the user. Every other signed-out entry says where to run the command.
 */
export function signInActionFor(
  entry: Pick<AccountAlertEntry, "kind" | "canSignIn">,
  context: SignInContext,
): SignInAction | null {
  if (entry.kind !== "signed_out") return null;
  const canSignInHere =
    entry.canSignIn && context.isElectron && context.hostSupportsSignIn && context.isLocalDaemon;
  return canSignInHere ? "sign_in" : "run_on_host";
}
