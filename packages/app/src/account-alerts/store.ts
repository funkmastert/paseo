import { useMemo } from "react";
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { compareAccountAlertEntries, type AccountAlertEntry } from "./account-alert-model";

interface AccountAlertState {
  /** Each connected host's alert entries. A host with none has no key. */
  byHost: Readonly<Record<string, readonly AccountAlertEntry[]>>;
}

export const useAccountAlertStore = create<AccountAlertState>(() => ({ byHost: {} }));

export const NO_ACCOUNT_ALERTS: readonly AccountAlertEntry[] = [];

function sameEntries(a: readonly AccountAlertEntry[], b: readonly AccountAlertEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => shallow(entry, b[index]));
}

/**
 * Replaces one host's entries. Every usage poll hands over a fresh array, so a report equal to
 * the last one leaves the state untouched and nothing subscribed re-renders.
 */
export function reportHostAccountAlerts(
  serverId: string,
  entries: readonly AccountAlertEntry[],
): void {
  useAccountAlertStore.setState((state) => {
    const previous = state.byHost[serverId] ?? NO_ACCOUNT_ALERTS;
    if (sameEntries(previous, entries)) return state;
    const byHost = { ...state.byHost };
    if (entries.length === 0) delete byHost[serverId];
    else byHost[serverId] = entries;
    return { byHost };
  });
}

/** Every connected host's entries in one list, in the banner's order. */
export function useAccountAlertEntries(): AccountAlertEntry[] {
  const byHost = useAccountAlertStore((state) => state.byHost);
  return useMemo(() => {
    const entries = Object.values(byHost).flat();
    return entries.sort(compareAccountAlertEntries);
  }, [byHost]);
}

export function useHasAccountAlerts(): boolean {
  return useAccountAlertStore((state) => Object.keys(state.byHost).length > 0);
}
