import { DaemonConfigStore, type MutableDaemonConfig } from "../daemon-config-store.js";

/**
 * A real DaemonConfigStore for tests that construct the daemon's pieces by hand. Hand-rolled
 * stubs only carry the methods the code read when they were written, so the next constructor that
 * reads config crashes every suite built on them. The startup config is passed in rather than read
 * from `paseoHome`, so nothing touches disk until a test patches the store.
 */
export function createTestDaemonConfigStore(
  overrides: Partial<MutableDaemonConfig> = {},
  paseoHome = "/tmp/paseo-test",
): DaemonConfigStore {
  return new DaemonConfigStore(
    paseoHome,
    {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      ...overrides,
    },
    undefined,
    { startupPersisted: { version: 1 } },
  );
}
