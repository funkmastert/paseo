import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createAccountAlertDismissStore, pruneAccountAlertDismissalsIn } from "./dismiss-store";

function createMemoryStorage(initial?: Record<string, string>): StateStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    values,
    getItem: async (name) => values.get(name) ?? null,
    setItem: async (name, value) => {
      values.set(name, value);
    },
    removeItem: async (name) => {
      values.delete(name);
    },
  };
}

describe("account alert dismiss store", () => {
  it("dismisses a fingerprint once, however many times it is dismissed", () => {
    const store = createAccountAlertDismissStore(createMemoryStorage());

    store.getState().dismiss(["server-1:claude:signed_out:2026-10-12T18:00:00Z"]);
    const afterFirst = store.getState();
    store.getState().dismiss(["server-1:claude:signed_out:2026-10-12T18:00:00Z"]);

    expect(store.getState().dismissedFingerprints).toEqual([
      "server-1:claude:signed_out:2026-10-12T18:00:00Z",
    ]);
    expect(store.getState()).toBe(afterFirst);
  });

  it("dismisses every fingerprint handed to it", () => {
    const store = createAccountAlertDismissStore(createMemoryStorage());

    store
      .getState()
      .dismiss([
        "server-1:claude:signed_out:2026-10-12T18:00:00Z",
        "server-1:claude-backup:identity:",
      ]);

    expect(store.getState().dismissedFingerprints).toEqual([
      "server-1:claude:signed_out:2026-10-12T18:00:00Z",
      "server-1:claude-backup:identity:",
    ]);
  });

  it("survives a reload of the store", async () => {
    const storage = createMemoryStorage();
    const first = createAccountAlertDismissStore(storage);
    await first.persist.rehydrate();
    first.getState().dismiss(["server-1:claude:signed_out:2026-10-12T18:00:00Z"]);

    const restored = createAccountAlertDismissStore(storage);
    await restored.persist.rehydrate();

    expect(restored.getState().dismissedFingerprints).toEqual([
      "server-1:claude:signed_out:2026-10-12T18:00:00Z",
    ]);
  });

  describe("pruneAccountAlertDismissalsIn", () => {
    it("drops a host's dismissed fingerprint once it no longer matches a live entry", () => {
      const store = createAccountAlertDismissStore(createMemoryStorage());
      store.getState().dismiss(["server-1:claude:signed_out:2026-10-12T18:00:00Z"]);

      pruneAccountAlertDismissalsIn(store, "server-1", []);

      expect(store.getState().dismissedFingerprints).toEqual([]);
    });

    it("keeps a host's dismissed fingerprint that still matches a live entry", () => {
      const store = createAccountAlertDismissStore(createMemoryStorage());
      store.getState().dismiss(["server-1:claude:signed_out:2026-10-12T18:00:00Z"]);

      pruneAccountAlertDismissalsIn(store, "server-1", [
        "server-1:claude:signed_out:2026-10-12T18:00:00Z",
      ]);

      expect(store.getState().dismissedFingerprints).toEqual([
        "server-1:claude:signed_out:2026-10-12T18:00:00Z",
      ]);
    });

    it("leaves another host's dismissed fingerprints alone", () => {
      const store = createAccountAlertDismissStore(createMemoryStorage());
      store
        .getState()
        .dismiss([
          "server-1:claude:signed_out:2026-10-12T18:00:00Z",
          "server-2:claude:signed_out:2026-10-12T18:00:00Z",
        ]);

      pruneAccountAlertDismissalsIn(store, "server-1", []);

      expect(store.getState().dismissedFingerprints).toEqual([
        "server-2:claude:signed_out:2026-10-12T18:00:00Z",
      ]);
    });
  });
});
