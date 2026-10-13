import AsyncStorage from "@react-native-async-storage/async-storage";
import { create, type StoreApi } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface AccountAlertDismissState {
  dismissedFingerprints: string[];
  dismiss: (fingerprints: readonly string[]) => void;
}

const AccountAlertDismissPersistedStateSchema = z.strictObject({
  dismissedFingerprints: z.array(z.string()),
});

export function createAccountAlertDismissStore(storage: StateStorage) {
  return create<AccountAlertDismissState>()(
    persist(
      (set) => ({
        dismissedFingerprints: [],
        dismiss: (fingerprints) =>
          set((state) => {
            const next = new Set([...state.dismissedFingerprints, ...fingerprints]);
            if (next.size === state.dismissedFingerprints.length) return state;
            return { dismissedFingerprints: [...next] };
          }),
      }),
      {
        name: "account-alert-dismissals",
        version: 1,
        storage: createValidatedPersistStorage(storage, AccountAlertDismissPersistedStateSchema),
        partialize: (state) => ({ dismissedFingerprints: state.dismissedFingerprints }),
      },
    ),
  );
}

export const useAccountAlertDismissStore = createAccountAlertDismissStore(AsyncStorage);

/**
 * Drops one host's dismissed fingerprints that no longer match a live entry, so the persisted
 * list does not grow without bound. Scoped to serverId: a fingerprint belonging to another host
 * is left untouched by this call, and the caller only calls it once that host's own usage view is
 * ready — a still-loading or disconnected host must never look like "nothing is live" and wipe a
 * dismissal that would otherwise still apply once it reports back in.
 *
 * The `${serverId}:` prefix match is unambiguous because a real serverId is a fixed-length
 * `srv_`-prefixed random token (see server-id.ts) and never itself contains a colon, so it can
 * never be mistaken for a prefix of a different host's serverId.
 */
export function pruneAccountAlertDismissalsIn(
  store: StoreApi<AccountAlertDismissState>,
  serverId: string,
  liveFingerprints: readonly string[],
): void {
  const live = new Set(liveFingerprints);
  const prefix = `${serverId}:`;
  store.setState((state) => {
    const next = state.dismissedFingerprints.filter(
      (fingerprint) => !fingerprint.startsWith(prefix) || live.has(fingerprint),
    );
    if (next.length === state.dismissedFingerprints.length) return state;
    return { dismissedFingerprints: next };
  });
}

export function pruneAccountAlertDismissals(
  serverId: string,
  liveFingerprints: readonly string[],
): void {
  pruneAccountAlertDismissalsIn(useAccountAlertDismissStore, serverId, liveFingerprints);
}

/**
 * Drops every dismissed fingerprint whose host is no longer registered at all, so an archived or
 * removed host's dismissals do not persist forever — unlike `pruneAccountAlertDismissalsIn`, which
 * only runs per still-connected host, so a host that disappears from the registry stops getting
 * pruned by anything else. The caller only calls this once the host registry has finished loading
 * from disk, so a transient empty list before that load completes never reads as "every host is
 * gone" and wipes every dismissal.
 */
export function pruneAccountAlertDismissalsForUnknownHostsIn(
  store: StoreApi<AccountAlertDismissState>,
  liveServerIds: readonly string[],
): void {
  const live = new Set(liveServerIds);
  store.setState((state) => {
    const next = state.dismissedFingerprints.filter((fingerprint) => {
      const colonIndex = fingerprint.indexOf(":");
      const serverId = colonIndex === -1 ? fingerprint : fingerprint.slice(0, colonIndex);
      return live.has(serverId);
    });
    if (next.length === state.dismissedFingerprints.length) return state;
    return { dismissedFingerprints: next };
  });
}

export function pruneAccountAlertDismissalsForUnknownHosts(liveServerIds: readonly string[]): void {
  pruneAccountAlertDismissalsForUnknownHostsIn(useAccountAlertDismissStore, liveServerIds);
}
