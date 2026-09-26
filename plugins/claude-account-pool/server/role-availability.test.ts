import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../shared/tool-profiles";
import type { RoleRecord } from "../shared/role-policy-schema";
import { createHealthTracker } from "./health";
import {
  evaluateRequestedModel,
  isRequestedModelApproved,
  selectModel,
  unadvertisedPoolEntries,
  type AvailabilityPool,
  type ModelCatalog,
} from "./role-availability";

function role(overrides: Partial<RoleRecord>): RoleRecord {
  return {
    id: "worker",
    name: "worker",
    standard: true,
    aliases: [],
    models: [],
    mechanicalModels: [],
    hardModels: [],
    toolProfile: DEFAULT_TOOL_PROFILE,
    ...overrides,
  };
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

  describe("Fable budget gate", () => {
    const FABLE = "claude-fable-5-1";
    const FABLE_WINDOW = "weekly_model_fable";
    const POOL: AvailabilityPool = {
      workers: [{ providerId: "worker-a" }],
      leader: { providerId: "leader" },
    };

    function poolAtFableUsage(usage: Record<string, number>) {
      const health = createHealthTracker();
      for (const [providerId, usedPct] of Object.entries(usage)) {
        health.reportUsage(providerId, [{ window: FABLE_WINDOW, usedPct }]);
      }
      return health;
    }

    it("selects Fable while an account is under the threshold", () => {
      const result = selectModel(
        role({ models: [FABLE, "claude-sonnet-5"] }),
        catalog({ claude: [FABLE, "claude-sonnet-5"] }),
        POOL,
        poolAtFableUsage({ leader: 94, "worker-a": 19 }),
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: FABLE });
    });

    it("falls to the next model in the role's own pool once every account is at/over the threshold", () => {
      // The measured state on 2026-09-17: leader 94%, workers 19% and 18% —
      // but with the workers pushed over too, nothing is left under budget.
      const result = selectModel(
        role({ models: [FABLE, "claude-sonnet-5"] }),
        catalog({ claude: [FABLE, "claude-sonnet-5"] }),
        POOL,
        poolAtFableUsage({ leader: 94, "worker-a": 88 }),
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-sonnet-5" });
    });

    it("gates at exactly the threshold, not just above it", () => {
      const result = selectModel(
        role({ models: [FABLE, "claude-sonnet-5"] }),
        catalog({ claude: [FABLE, "claude-sonnet-5"] }),
        POOL,
        poolAtFableUsage({ leader: 80, "worker-a": 80 }),
      );
      expect(result.outcome === "selected" && result.model).toBe("claude-sonnet-5");
    });

    it("honours a configured threshold", () => {
      const health = poolAtFableUsage({ leader: 50, "worker-a": 50 });
      const models = { models: [FABLE, "claude-sonnet-5"] };

      expect(selectModel(role(models), catalog({ claude: [FABLE, "claude-sonnet-5"] }), POOL, health)).toMatchObject({
        model: FABLE,
      });
      expect(
        selectModel(role(models), catalog({ claude: [FABLE, "claude-sonnet-5"] }), POOL, health, {
          modelBudgetThresholdPct: 40,
        }),
      ).toMatchObject({ model: "claude-sonnet-5" });
    });

    it("does not gate a non-Fable model at the same utilization", () => {
      const health = createHealthTracker();
      health.reportUsage("worker-a", [{ window: "weekly_model_sonnet", usedPct: 95 }]);
      health.reportUsage("leader", [{ window: "weekly_model_sonnet", usedPct: 95 }]);

      const result = selectModel(
        role({ models: ["claude-sonnet-5", "claude-haiku-4-5"] }),
        catalog({ claude: ["claude-sonnet-5", "claude-haiku-4-5"] }),
        POOL,
        health,
      );
      expect(result).toMatchObject({ model: "claude-sonnet-5" });
    });

    it("does not gate when no usage reading has arrived yet", () => {
      const result = selectModel(
        role({ models: [FABLE, "claude-sonnet-5"] }),
        catalog({ claude: [FABLE, "claude-sonnet-5"] }),
        POOL,
        createHealthTracker(),
      );
      expect(result).toMatchObject({ model: FABLE });
    });

    it("an exhausted pool falls back to the role's own models[0], never borrowing", () => {
      const result = selectModel(
        role({ models: [FABLE] }),
        catalog({ claude: [FABLE] }),
        POOL,
        poolAtFableUsage({ leader: 94, "worker-a": 88 }),
      );
      expect(result).toEqual({ outcome: "unavailable", provider: null, model: FABLE });
    });
  });

  describe("taskClass-scoped pools", () => {
    it("uses role.models (standard) when taskClass is omitted, even if mechanicalModels/hardModels are configured", () => {
      const result = selectModel(
        role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: ["claude-opus-5"] }),
        catalog({ claude: ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"] }),
        ONE_WORKER_POOL,
        createHealthTracker(),
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-sonnet-5" });
    });

    it("uses the class-specific pool when taskClass is set and configured", () => {
      const result = selectModel(
        role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: ["claude-opus-5"] }),
        catalog({ claude: ["claude-sonnet-5", "claude-haiku-5", "claude-opus-5"] }),
        ONE_WORKER_POOL,
        createHealthTracker(),
        { taskClass: "hard" },
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-opus-5" });
    });

    it("falls back to role.models for a class with no override pool configured", () => {
      const result = selectModel(
        role({ models: ["claude-sonnet-5"], mechanicalModels: [], hardModels: [] }),
        catalog({ claude: ["claude-sonnet-5"] }),
        ONE_WORKER_POOL,
        createHealthTracker(),
        { taskClass: "mechanical" },
      );
      expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-sonnet-5" });
    });

    it("an explicitly requested model is only 'configured' against the resolved class's pool", () => {
      const r = role({ models: ["claude-sonnet-5"], mechanicalModels: ["claude-haiku-5"], hardModels: [] });
      expect(isRequestedModelApproved(r, "claude", "claude-haiku-5")).toBe(false); // standard (default) pool
      expect(isRequestedModelApproved(r, "claude", "claude-haiku-5", "mechanical")).toBe(true);

      const evaluation = evaluateRequestedModel(
        r,
        "claude",
        "claude-haiku-5",
        catalog({ claude: ["claude-sonnet-5", "claude-haiku-5"] }),
        ONE_WORKER_POOL,
        createHealthTracker(),
        { taskClass: "mechanical" },
      );
      expect(evaluation).toEqual({ configured: true, eligible: true });
    });
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

describe("evaluateRequestedModel — an explicit request for a model the catalog doesn't list", () => {
  // Claude Code 2.1.280 runs claude-opus-5-5 but does not advertise it.
  const OPUS_5_5 = "claude-opus-5-5";
  const r = role({ models: ["claude-sonnet-5", OPUS_5_5] });
  const advertised = catalog({ claude: ["claude-sonnet-5", "claude-opus-5"] }); // no opus-5-5
  const evaluate = (
    options: Parameters<typeof evaluateRequestedModel>[6] = {},
    model = OPUS_5_5,
    health = createHealthTracker(),
    subject = r,
  ) => evaluateRequestedModel(subject, "claude", model, advertised, ONE_WORKER_POOL, health, options);

  it("stays refused by default — the catalog check is unchanged for an operator who opts into nothing", () => {
    expect(evaluate()).toEqual({ configured: true, eligible: false, missingFromCatalog: true });
    expect(evaluate({ allowUnlistedModels: [] })).toEqual({ configured: true, eligible: false, missingFromCatalog: true });
  });

  it("is eligible, and says it is unverified, when the operator allowlisted the exact id", () => {
    expect(evaluate({ allowUnlistedModels: [OPUS_5_5] })).toEqual({ configured: true, eligible: true, unadvertised: true });
  });

  it("does not flag a model the catalog DOES list as unadvertised, even if it is also allowlisted", () => {
    expect(evaluate({ allowUnlistedModels: ["claude-sonnet-5"] }, "claude-sonnet-5")).toEqual({ configured: true, eligible: true });
  });

  it("matches per id: an allowlisted claude-opus-5-5 does not unlock a typo'd claude-opus-5-6", () => {
    const withTypoInPool = role({ models: [OPUS_5_5, "claude-opus-5-6"] });
    const result = evaluate({ allowUnlistedModels: [OPUS_5_5] }, "claude-opus-5-6", createHealthTracker(), withTypoInPool);
    expect(result).toEqual({ configured: true, eligible: false, missingFromCatalog: true });
  });

  it("adds no approval: an allowlisted id the role's pool never named is still not-approved", () => {
    const unapproved = role({ models: ["claude-sonnet-5"] });
    const result = evaluate({ allowUnlistedModels: [OPUS_5_5] }, OPUS_5_5, createHealthTracker(), unapproved);
    expect(result).toEqual({ configured: false, eligible: false });
  });

  it("matches by family: an allowlist entry for another provider's model id does not unlock the claude one", () => {
    expect(evaluate({ allowUnlistedModels: [`codex/${OPUS_5_5}`] })).toMatchObject({ eligible: false, missingFromCatalog: true });
  });

  it("stays refused when the pool is drained, even though the id is allowlisted (capped is not the same as unadvertised)", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportTurnFailure("leader", "hit your limit");
    const result = evaluate({ allowUnlistedModels: [OPUS_5_5] }, OPUS_5_5, health);
    expect(result).toEqual({ configured: true, eligible: false }); // not tagged missingFromCatalog: the lever isn't the allowlist
  });

  it("stays refused when the model's family is over its weekly budget, even though the id is allowlisted", () => {
    const fable = role({ models: ["claude-fable-6"] });
    const health = createHealthTracker();
    health.reportUsage("worker-a", [{ window: "weekly_model_fable", usedPct: 100 }]);
    health.reportUsage("leader", [{ window: "weekly_model_fable", usedPct: 100 }]);
    const result = evaluate({ allowUnlistedModels: ["claude-fable-6"] }, "claude-fable-6", health, fable);
    expect(result).toEqual({ configured: true, eligible: false });
  });

  it("honors the allowlist for a task class's own pool, not just the standard one", () => {
    const classed = role({ models: ["claude-sonnet-5"], hardModels: [OPUS_5_5] });
    const standard = evaluate({ allowUnlistedModels: [OPUS_5_5] }, OPUS_5_5, createHealthTracker(), classed);
    const hard = evaluate({ allowUnlistedModels: [OPUS_5_5], taskClass: "hard" }, OPUS_5_5, createHealthTracker(), classed);
    expect(standard).toEqual({ configured: false, eligible: false });
    expect(hard).toEqual({ configured: true, eligible: true, unadvertised: true });
  });
});

describe("selectModel — unadvertised pool entries", () => {
  const OPUS_5_5 = "claude-opus-5-5";
  const advertised = catalog({ claude: ["claude-sonnet-5", "claude-opus-5"] });
  const r = role({ models: [OPUS_5_5, "claude-opus-5"] });

  it("skips an unadvertised entry the operator has NOT allowlisted and takes the next advertised one", () => {
    const result = selectModel(r, advertised, ONE_WORKER_POOL, createHealthTracker());
    expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-opus-5" });
  });

  it("selects an ALLOWLISTED unadvertised entry as the pool default, flagged unadvertised", () => {
    const result = selectModel(r, advertised, ONE_WORKER_POOL, createHealthTracker(), {
      allowUnlistedModels: [OPUS_5_5],
    });
    expect(result).toEqual({ outcome: "selected", provider: null, model: OPUS_5_5, unadvertised: true });
  });

  it("does not flag an entry the catalog lists, even when it is also allowlisted", () => {
    const result = selectModel(r, advertised, ONE_WORKER_POOL, createHealthTracker(), {
      allowUnlistedModels: ["claude-opus-5"],
    });
    expect(result).toEqual({ outcome: "selected", provider: null, model: "claude-opus-5" });
  });

  it("allowlisting one id leaves an earlier, different unadvertised entry skipped", () => {
    const result = selectModel(role({ models: ["claude-opus-5-6", OPUS_5_5] }), advertised, ONE_WORKER_POOL, createHealthTracker(), {
      allowUnlistedModels: [OPUS_5_5],
    });
    expect(result).toMatchObject({ outcome: "selected", model: OPUS_5_5, unadvertised: true });
  });

  it("keeps an allowlisted entry behind the capacity gates: a drained pool skips it", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportTurnFailure("leader", "hit your limit");
    const result = selectModel(role({ models: [OPUS_5_5, "claude-sonnet-5"] }), advertised, ONE_WORKER_POOL, health, {
      allowUnlistedModels: [OPUS_5_5],
    });
    // Every entry is capped: falls back to models[0], which is the unverified id, and says so.
    expect(result).toEqual({ outcome: "unavailable", provider: null, model: OPUS_5_5, unadvertised: true });
  });

  it("matches the allowlist by family: a codex-pinned allowlist entry does not unlock the claude id", () => {
    const result = selectModel(r, advertised, ONE_WORKER_POOL, createHealthTracker(), {
      allowUnlistedModels: [`codex/${OPUS_5_5}`],
    });
    expect(result).toMatchObject({ model: "claude-opus-5" });
  });

  it("does not flag an unavailable fallback that is not allowlisted", () => {
    const health = createHealthTracker();
    health.reportTurnFailure("worker-a", "hit your limit");
    health.reportTurnFailure("leader", "hit your limit");
    const result = selectModel(r, advertised, ONE_WORKER_POOL, health);
    expect(result).toEqual({ outcome: "unavailable", provider: null, model: OPUS_5_5 });
  });
});

describe("unadvertisedPoolEntries", () => {
  it("lists the entries of the resolved class's pool that the catalog doesn't carry, in pool order", () => {
    const r = role({ models: ["claude-sonnet-5"], hardModels: ["claude-opus-5-5", "claude-opus-5", "codex/gpt-9"] });
    const advertised = catalog({ claude: ["claude-opus-5", "claude-sonnet-5"], codex: ["gpt-5"] });
    expect(unadvertisedPoolEntries(r, advertised, "hard")).toEqual(["claude-opus-5-5", "codex/gpt-9"]);
    expect(unadvertisedPoolEntries(r, advertised)).toEqual([]);
  });

  it("leaves out entries the operator allowlisted, since ordered selection no longer skips them", () => {
    const r = role({ hardModels: ["claude-opus-5-5", "codex/gpt-9"] });
    expect(unadvertisedPoolEntries(r, catalog({ claude: [], codex: [] }), "hard", ["claude-opus-5-5"])).toEqual(["codex/gpt-9"]);
  });
});
