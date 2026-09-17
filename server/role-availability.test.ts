import { describe, expect, it } from "vitest";
import type { RoleRecord } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import { selectModel, type AvailabilityPool, type ModelCatalog } from "./role-availability";

function role(overrides: Partial<RoleRecord>): RoleRecord {
  return { id: "worker", name: "worker", standard: true, aliases: [], models: [], ...overrides };
}

function catalog(entries: Record<string, string[]>): ModelCatalog {
  return new Map(Object.entries(entries).map(([family, models]) => [family, new Set(models)]));
}

const EMPTY_POOL: AvailabilityPool = { workers: [], leader: null };
const ONE_WORKER_POOL: AvailabilityPool = { workers: [{ providerId: "worker-a" }], leader: { providerId: "leader" } };

describe("selectModel", () => {
  it("UNCONFIGURED: an empty models list passes through byte-identical (no lookups needed)", () => {
    const result = selectModel(role({ models: [] }), catalog({}), EMPTY_POOL, createHealthTracker());
    expect(result).toEqual({ outcome: "unconfigured" });
  });

  it("selects the first catalog-present, non-claude model in order", () => {
    const result = selectModel(
      role({ models: ["codex/gpt-5.1", "codex/gpt-4"] }),
      catalog({ codex: ["gpt-5.1", "gpt-4"] }),
      EMPTY_POOL,
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "selected", provider: "codex", model: "gpt-5.1" });
  });

  it("skips a model missing from the live catalog and advances to the next", () => {
    const result = selectModel(
      role({ models: ["codex/gpt-does-not-exist", "codex/gpt-4"] }),
      catalog({ codex: ["gpt-4"] }),
      EMPTY_POOL,
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "selected", provider: "codex", model: "gpt-4" });
  });

  it("catalog presence is the whole check for non-claude families (no pool/health involvement)", () => {
    const result = selectModel(
      role({ models: ["gemini/gemini-3-pro"] }),
      catalog({ gemini: ["gemini-3-pro"] }),
      EMPTY_POOL, // no pool members at all
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "selected", provider: "gemini", model: "gemini-3-pro" });
  });

  it("claude-family: skips a catalog-present model with no viable pool member", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit"); // caps the account window
    health.reportTurnFailure("leader", "hit your limit");
    const result = selectModel(
      role({ models: ["claude/claude-opus-4", "codex/gpt-4"] }),
      catalog({ claude: ["claude-opus-4"], codex: ["gpt-4"] }),
      ONE_WORKER_POOL,
      health,
    );
    expect(result).toEqual({ outcome: "selected", provider: "codex", model: "gpt-4" });
  });

  it("claude-family: eligible when a worker is healthy for the model", () => {
    const result = selectModel(
      role({ models: ["claude/claude-opus-4"] }),
      catalog({ claude: ["claude-opus-4"] }),
      ONE_WORKER_POOL,
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "selected", provider: "claude", model: "claude-opus-4" });
  });

  it("claude-family: capped-everywhere-but-leader is still eligible (viable-anywhere, looser than the router's ladder)", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit"); // caps the only worker; leader stays healthy
    const result = selectModel(
      role({ models: ["claude/claude-opus-4"] }),
      catalog({ claude: ["claude-opus-4"] }),
      ONE_WORKER_POOL,
      health,
    );
    expect(result).toEqual({ outcome: "selected", provider: "claude", model: "claude-opus-4" });
  });

  it("claude-family: last-resort-eligible (drained, not capped) counts as viable", () => {
    const health = createHealthTracker();
    // Drain (not cap) the leader; cap the worker outright so only the drained
    // leader's last-resort eligibility can make this selectable.
    health.reportUsage("leader", [{ window: "five_hour", usedPct: 95 }]);
    health.reportTurnFailure("worker-a", "hit your limit");
    const result = selectModel(
      role({ models: ["claude/claude-opus-4"] }),
      catalog({ claude: ["claude-opus-4"] }),
      ONE_WORKER_POOL,
      health,
    );
    expect(result).toEqual({ outcome: "selected", provider: "claude", model: "claude-opus-4" });
  });

  it("order-preserving: an eligible earlier entry wins over a later, also-eligible entry", () => {
    const result = selectModel(
      role({ models: ["codex/gpt-4", "codex/gpt-5.1"] }),
      catalog({ codex: ["gpt-4", "gpt-5.1"] }),
      EMPTY_POOL,
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "selected", provider: "codex", model: "gpt-4" });
  });

  it("UNAVAILABLE: nothing eligible falls back to models[0] rather than skipping the request", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportTurnFailure("leader", "hit your limit");
    const result = selectModel(
      role({ models: ["claude/claude-opus-4", "claude/claude-sonnet-4"] }),
      catalog({ claude: ["claude-opus-4", "claude-sonnet-4"] }),
      ONE_WORKER_POOL,
      health,
    );
    expect(result).toEqual({ outcome: "unavailable", provider: "claude", model: "claude-opus-4" });
  });

  it("UNAVAILABLE: also triggered when every entry is catalog-missing", () => {
    const result = selectModel(
      role({ models: ["codex/gpt-ghost"] }),
      catalog({}),
      EMPTY_POOL,
      createHealthTracker(),
    );
    expect(result).toEqual({ outcome: "unavailable", provider: "codex", model: "gpt-ghost" });
  });

  describe("account-agnostic (bare) refs", () => {
    it("resolves against the pool family's catalog and reports a null provider", () => {
      const result = selectModel(
        role({ models: ["claude-opus-4"] }),
        catalog({ claude: ["claude-opus-4"] }),
        ONE_WORKER_POOL,
        createHealthTracker(),
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-opus-4" });
    });

    it("stays eligible while ANY pooled account is viable, not just the leader", () => {
      const health = createHealthTracker();
      health.reportTurnFailure("leader", "hit your limit"); // the account that died on 2026-09-15
      const result = selectModel(
        role({ models: ["claude-opus-4"] }),
        catalog({ claude: ["claude-opus-4"] }),
        ONE_WORKER_POOL,
        health,
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-opus-4" });
    });

    it("still skips to the next entry when no pooled account is viable", () => {
      const health = createHealthTracker();
      health.reportTurnFailure("worker-a", "hit your limit");
      health.reportTurnFailure("leader", "hit your limit");
      const result = selectModel(
        role({ models: ["claude-opus-4", "codex/gpt-4"] }),
        catalog({ claude: ["claude-opus-4"], codex: ["gpt-4"] }),
        ONE_WORKER_POOL,
        health,
      );
      expect(result).toEqual({ outcome: "selected", provider: "codex", model: "gpt-4" });
    });
  });
});
