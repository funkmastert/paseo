import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type PullRequestLedgerRow, PullRequestLedgerStore } from "./pull-request-ledger-store.js";

const logger = { warn: () => undefined };

function row(overrides: Partial<PullRequestLedgerRow> = {}): PullRequestLedgerRow {
  return {
    id: "github.com/acme/widgets#42",
    agentId: "agent-1",
    agentTitle: "Add retry logic",
    agentCwd: "/repo",
    host: "github.com",
    repoOwner: "acme",
    repoName: "widgets",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    forge: "github",
    detectedAtMs: 1000,
    status: "open",
    lastStatusCheckedAtMs: null,
    ...overrides,
  };
}

describe("PullRequestLedgerStore", () => {
  test("round-trips every field of a row through a flush and a fresh load", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-roundtrip-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertRow(row());
      await store.flush();

      const reloaded = new PullRequestLedgerStore({ rootDir, logger });
      await reloaded.load();
      expect(reloaded.getRow("github.com/acme/widgets#42")).toEqual(row());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("upserting an existing identity replaces the row (status transition persists)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-upsert-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertRow(row());
      store.upsertRow(row({ status: "merged", lastStatusCheckedAtMs: 5000 }));
      expect(store.listRows()).toHaveLength(1);
      expect(store.getRow("github.com/acme/widgets#42")?.status).toBe("merged");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("row-cap eviction drops the oldest row when at capacity", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-cap-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger, limits: { maxRows: 2 } });
      await store.load();
      store.upsertRow(row({ id: "a", detectedAtMs: 1000 }));
      store.upsertRow(row({ id: "b", detectedAtMs: 2000 }));
      store.upsertRow(row({ id: "c", detectedAtMs: 3000 }));
      const ids = store.listRows().map((r) => r.id);
      expect(ids).toHaveLength(2);
      expect(ids).not.toContain("a");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("prune drops rows past retention", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-prune-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger, limits: { retentionDays: 1 } });
      await store.load();
      const dayMs = 24 * 60 * 60 * 1000;
      store.upsertRow(row({ id: "old", detectedAtMs: 0 }));
      store.upsertRow(row({ id: "new", detectedAtMs: dayMs * 10 }));
      store.prune(dayMs * 10 + 1000);
      expect(store.listRows().map((r) => r.id)).toEqual(["new"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a corrupt state file is replaced; the store starts empty instead of throwing", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-corrupt-"));
    try {
      writeFileSync(join(rootDir, "state.json"), "{ not json");
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.listRows()).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("an unreadable state file leaves a subsequent write a no-op", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-unreadable-"));
    try {
      const statePath = join(rootDir, "state.json");
      writeFileSync(statePath, JSON.stringify({ v: 1, rows: [row()] }));
      chmodSync(statePath, 0o000);
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertRow(row({ id: "new-row" }));
      await store.flush();
      // The original bytes are untouched; the store refused to overwrite an unreadable file.
      expect(() => readFileSync(statePath, "utf8")).toThrow();
    } finally {
      chmodSync(join(rootDir, "state.json"), 0o600);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a field added after this release is optional on read", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-forward-compat-"));
    try {
      writeFileSync(
        join(rootDir, "state.json"),
        JSON.stringify({
          v: 1,
          rows: [{ ...row(), lastStatusCheckedAtMs: undefined, futureField: "x" }],
        }),
      );
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.getRow("github.com/acme/widgets#42")?.lastStatusCheckedAtMs).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
