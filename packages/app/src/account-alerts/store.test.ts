import { beforeEach, describe, expect, it } from "vitest";
import type { AccountAlertEntry } from "./account-alert-model";
import { reportHostAccountAlerts, useAccountAlertStore } from "./store";

function entry(overrides: Partial<AccountAlertEntry> = {}): AccountAlertEntry {
  return {
    providerId: "claude-backup",
    serverId: "server-1",
    hostLabel: "Host One",
    label: "Backup",
    kind: "signed_out",
    summary: "claude-backup is signed out",
    fixCommand: "claude auth login",
    canSignIn: true,
    ...overrides,
  };
}

beforeEach(() => {
  useAccountAlertStore.setState({ byHost: {} });
});

describe("reportHostAccountAlerts", () => {
  it("keeps the state when a poll reports the same entries in a fresh array", () => {
    reportHostAccountAlerts("server-1", [entry()]);
    const before = useAccountAlertStore.getState();

    reportHostAccountAlerts("server-1", [entry()]);

    expect(useAccountAlertStore.getState()).toBe(before);
  });

  it("replaces a host's entries when any field changes", () => {
    reportHostAccountAlerts("server-1", [entry()]);
    const before = useAccountAlertStore.getState().byHost;

    reportHostAccountAlerts("server-1", [entry({ kind: "identity", canSignIn: false })]);

    const after = useAccountAlertStore.getState().byHost;
    expect(after).not.toBe(before);
    expect(after["server-1"]).toEqual([entry({ kind: "identity", canSignIn: false })]);
  });

  it("drops a host that reports nothing, leaving the other hosts alone", () => {
    reportHostAccountAlerts("server-1", [entry()]);
    reportHostAccountAlerts("server-2", [entry({ serverId: "server-2" })]);

    reportHostAccountAlerts("server-1", []);

    expect(Object.keys(useAccountAlertStore.getState().byHost)).toEqual(["server-2"]);
  });

  it("does nothing for a host that had no entries and still has none", () => {
    const before = useAccountAlertStore.getState();

    reportHostAccountAlerts("server-1", []);

    expect(useAccountAlertStore.getState()).toBe(before);
  });
});
