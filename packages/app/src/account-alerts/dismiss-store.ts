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
