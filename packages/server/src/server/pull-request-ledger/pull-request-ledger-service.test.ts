import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import {
  type PullRequestLedgerAgentManager,
  PullRequestLedgerService,
} from "./pull-request-ledger-service.js";
import { PullRequestLedgerStore } from "./pull-request-ledger-store.js";

const logger = { warn: () => undefined };

interface AgentRecordFixture {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  title: string | null;
}

function toolCallRow(name: string, command: string, output: string, seq: number): AgentTimelineRow {
  return {
    seq,
    timestamp: new Date(seq).toISOString(),
    item: {
      type: "tool_call",
      status: "completed",
      error: null,
      callId: `call-${seq}`,
      name,
      detail: { type: "shell", command, output, exitCode: 0 },
    },
  };
}

function fakeAgentManager(options: {
  records?: AgentRecordFixture[];
  residentAgents?: Array<{ id: string; title: string | null }>;
  residentTimelines?: Record<string, AgentTimelineRow[]>;
}): PullRequestLedgerAgentManager & { emit: (agentId: string, row: AgentTimelineRow) => void } {
  const listeners = new Set<(agentId: string, row: AgentTimelineRow) => void>();
  return {
    subscribeTimelineRecorded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listResidentAgents() {
      return options.residentAgents ?? [];
    },
    async getTimelineRows(agentId: string) {
      return options.residentTimelines?.[agentId] ?? [];
    },
    async listAgentRecordsForPullRequestLedger() {
      return options.records ?? [];
    },
    emit(agentId, row) {
      for (const listener of listeners) listener(agentId, row);
    },
  };
}

describe("PullRequestLedgerService", () => {
  test("a detectable completed tool call upserts a store row for that agent", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-live-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      const agentManager = fakeAgentManager({});
      const service = new PullRequestLedgerService({ store, agentManager });
      service.start();

      agentManager.emit(
        "agent-1",
        toolCallRow("Bash", "gh pr create --fill", "https://github.com/acme/widgets/pull/42", 1),
      );

      const row = store.getRow("github.com/acme/widgets#42");
      expect(row?.agentId).toBe("agent-1");
      expect(row?.status).toBe("open");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("a non-detectable tool call is a no-op", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-noop-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      const agentManager = fakeAgentManager({});
      const service = new PullRequestLedgerService({ store, agentManager });
      service.start();

      agentManager.emit("agent-1", toolCallRow("Bash", "gh pr list", "no PRs here", 1));

      expect(store.listRows()).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("boot backfill scans resident agents' already-hydrated timelines", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-backfill-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      const agentManager = fakeAgentManager({
        residentAgents: [{ id: "agent-1", title: "Ship the thing" }],
        residentTimelines: {
          "agent-1": [
            toolCallRow(
              "Bash",
              "gh pr create --fill",
              "https://github.com/acme/widgets/pull/42",
              1,
            ),
          ],
        },
      });
      const service = new PullRequestLedgerService({ store, agentManager });
      await service.backfillResidentAgents();

      const row = store.getRow("github.com/acme/widgets#42");
      expect(row?.agentId).toBe("agent-1");
      expect(row?.agentTitle).toBe("Ship the thing");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("list() for a workspace whose root has a child in a different workspace still includes the child's PRs", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-cross-workspace-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertRow({
        id: "github.com/acme/widgets#42",
        agentId: "child-1",
        agentTitle: null,
        host: "github.com",
        repoOwner: "acme",
        repoName: "widgets",
        number: 42,
        url: "https://github.com/acme/widgets/pull/42",
        forge: "github",
        detectedAtMs: 1000,
        status: "open",
        lastStatusCheckedAtMs: null,
      });
      const agentManager = fakeAgentManager({
        records: [
          { id: "root-1", workspaceId: "ws-a", parentAgentId: null, title: "Leader" },
          { id: "child-1", workspaceId: "ws-b", parentAgentId: "root-1", title: "Worker" },
        ],
      });
      const service = new PullRequestLedgerService({ store, agentManager });

      const rows = await service.list("ws-a");
      expect(rows.map((r) => r.id)).toEqual(["github.com/acme/widgets#42"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("list() includes PRs from an archived descendant", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-archived-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      store.upsertRow({
        id: "github.com/acme/widgets#7",
        agentId: "archived-child",
        agentTitle: null,
        host: "github.com",
        repoOwner: "acme",
        repoName: "widgets",
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        forge: "github",
        detectedAtMs: 1000,
        status: "merged",
        lastStatusCheckedAtMs: 2000,
      });
      const agentManager = fakeAgentManager({
        records: [
          { id: "root-1", workspaceId: "ws-a", parentAgentId: null, title: "Leader" },
          { id: "archived-child", workspaceId: "ws-a", parentAgentId: "root-1", title: "Done" },
        ],
      });
      const service = new PullRequestLedgerService({ store, agentManager });

      const rows = await service.list("ws-a");
      expect(rows.map((r) => r.id)).toEqual(["github.com/acme/widgets#7"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("list() for a workspace with no agents returns an empty array", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pr-ledger-service-empty-"));
    try {
      const store = new PullRequestLedgerStore({ rootDir, logger });
      await store.load();
      const agentManager = fakeAgentManager({ records: [] });
      const service = new PullRequestLedgerService({ store, agentManager });

      await expect(service.list("ws-unknown")).resolves.toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
