import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import {
  buildAccountAlertEntries,
  signInActionFor,
  type AccountAlertHostUsage,
} from "./account-alert-model";

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: null,
    windows: [],
    ...overrides,
  };
}

function host(overrides: Partial<AccountAlertHostUsage> = {}): AccountAlertHostUsage {
  return {
    serverId: "server-1",
    hostLabel: "Host One",
    providers: [],
    ...overrides,
  };
}

describe("buildAccountAlertEntries", () => {
  it("produces a signed_out entry from accountAuth", () => {
    const entries = buildAccountAlertEntries([
      host({
        providers: [
          usage({
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login --email someone@example.com",
              canSignIn: true,
            },
          }),
        ],
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "signed_out",
      summary: "Signed out",
      fixCommand: "claude auth login --email someone@example.com",
      canSignIn: true,
    });
  });

  it("produces an identity entry from accountIdentity", () => {
    const entries = buildAccountAlertEntries([
      host({
        providers: [
          usage({
            accountIdentity: {
              kind: "wrong-login",
              summary: "Wrong login",
              fixCommand: "claude auth login --email someone@example.com",
            },
          }),
        ],
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "identity",
      summary: "Wrong login",
      canSignIn: false,
    });
  });

  it("prefers accountAuth over accountIdentity when a row carries both", () => {
    const entries = buildAccountAlertEntries([
      host({
        providers: [
          usage({
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login",
              canSignIn: true,
            },
            accountIdentity: {
              kind: "shared-login",
              summary: "Shared login",
              fixCommand: "claude auth login --email someone@example.com",
            },
          }),
        ],
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("signed_out");
  });

  it("produces nothing for a row with neither field", () => {
    const entries = buildAccountAlertEntries([host({ providers: [usage()] })]);
    expect(entries).toHaveLength(0);
  });

  it("excludes a disabled provider even when it carries accountAuth", () => {
    const disabledEntries: ProviderSnapshotEntry[] = [
      { provider: "claude-backup", status: "ready", enabled: false, label: "Backup" },
    ];
    const entries = buildAccountAlertEntries([
      host({
        entries: disabledEntries,
        providers: [
          usage({
            providerId: "claude-backup",
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login",
              canSignIn: true,
            },
          }),
        ],
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("sorts signed_out before identity, then by label", () => {
    const entries = buildAccountAlertEntries([
      host({
        providers: [
          usage({
            providerId: "claude-zeta",
            displayName: "Zeta",
            accountIdentity: {
              kind: "wrong-login",
              summary: "Wrong login",
              fixCommand: "claude auth login",
            },
          }),
          usage({
            providerId: "claude-beta",
            displayName: "Beta",
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login",
              canSignIn: true,
            },
          }),
          usage({
            providerId: "claude-alpha",
            displayName: "Alpha",
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login",
              canSignIn: true,
            },
          }),
        ],
      }),
    ]);
    expect(entries.map((entry) => entry.label)).toEqual(["Alpha", "Beta", "Zeta"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["signed_out", "signed_out", "identity"]);
  });

  it("merges rows from two hosts and names each entry's host", () => {
    const entries = buildAccountAlertEntries([
      host({
        serverId: "server-1",
        hostLabel: "Host One",
        providers: [
          usage({
            providerId: "claude-personal",
            accountAuth: {
              state: "signed_out",
              since: "2026-10-12T18:00:00Z",
              summary: "Signed out",
              fixCommand: "claude auth login",
              canSignIn: true,
            },
          }),
        ],
      }),
      host({
        serverId: "server-2",
        hostLabel: "Host Two",
        providers: [
          usage({
            providerId: "claude-backup",
            accountIdentity: {
              kind: "shared-login",
              summary: "Shared login",
              fixCommand: "claude auth login",
            },
          }),
        ],
      }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.providerId === "claude-personal")?.hostLabel).toBe(
      "Host One",
    );
    expect(entries.find((entry) => entry.providerId === "claude-backup")?.hostLabel).toBe(
      "Host Two",
    );
  });
});

describe("signInActionFor", () => {
  const here = { isElectron: true, hostSupportsSignIn: true, isLocalDaemon: true };
  const signedOut = { kind: "signed_out" as const, canSignIn: true };

  it("offers Sign in for a signed-out entry on the desktop's own daemon", () => {
    expect(signInActionFor(signedOut, here)).toBe("sign_in");
  });

  it.each([
    ["the daemon cannot start a login", { ...signedOut, canSignIn: false }, here],
    ["the app is not Electron", signedOut, { ...here, isElectron: false }],
    ["the host does not serve the sign-in RPC", signedOut, { ...here, hostSupportsSignIn: false }],
    ["the entry is on a remote host", signedOut, { ...here, isLocalDaemon: false }],
  ])("falls back to running the command on the host when %s", (_reason, entry, context) => {
    expect(signInActionFor(entry, context)).toBe("run_on_host");
  });

  it("offers nothing for an identity entry", () => {
    expect(signInActionFor({ kind: "identity", canSignIn: false }, here)).toBeNull();
    expect(signInActionFor({ kind: "identity", canSignIn: true }, here)).toBeNull();
  });
});
