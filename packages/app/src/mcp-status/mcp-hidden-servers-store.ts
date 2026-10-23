import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const HiddenByServerIdSchema = z.record(z.string(), z.array(z.string()));
const McpHiddenServersPersistedStateSchema = z.strictObject({
  hiddenByServerId: HiddenByServerIdSchema,
});

interface McpHiddenServersStoreState {
  /** MCP server names hidden from the strip, per host. */
  hiddenByServerId: Record<string, string[]>;
  hide: (serverId: string, name: string) => void;
  unhide: (serverId: string, names: readonly string[]) => void;
}

const NO_HIDDEN_SERVERS: readonly string[] = [];

/**
 * The MCP servers someone hid from the strip — a claude.ai connector they never use, a provider
 * that refuses to register Paseo. Per host, because server names are, and client-only: the
 * desktop app and the phone keep separate lists.
 */
export const useMcpHiddenServersStore = create<McpHiddenServersStoreState>()(
  persist(
    (set) => ({
      hiddenByServerId: {},
      hide: (serverId, name) =>
        set((state) => {
          const current = state.hiddenByServerId[serverId] ?? [];
          if (current.includes(name)) return state;
          return {
            hiddenByServerId: { ...state.hiddenByServerId, [serverId]: [...current, name] },
          };
        }),
      unhide: (serverId, names) =>
        set((state) => {
          const current = state.hiddenByServerId[serverId] ?? [];
          const next = current.filter((name) => !names.includes(name));
          if (next.length === current.length) return state;
          return { hiddenByServerId: { ...state.hiddenByServerId, [serverId]: next } };
        }),
    }),
    {
      name: "mcp-hidden-servers",
      storage: createValidatedPersistStorage(AsyncStorage, McpHiddenServersPersistedStateSchema),
      partialize: (state) => ({ hiddenByServerId: state.hiddenByServerId }),
      version: 1,
    },
  ),
);

/** The hidden names for one host. Stable between changes, so it can feed a memo directly. */
export function useMcpHiddenServerNames(serverId: string | null): readonly string[] {
  return useMcpHiddenServersStore((state) =>
    serverId ? (state.hiddenByServerId[serverId] ?? NO_HIDDEN_SERVERS) : NO_HIDDEN_SERVERS,
  );
}
