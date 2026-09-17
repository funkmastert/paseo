import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_PROFILE } from "../shared/tool-profiles";
import { DEFAULT_MODEL_BUDGET_THRESHOLD_PCT } from "../shared/role-policy-schema";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { DEFAULT_POLICY, type RoleModelPolicy } from "../shared/role-policy-schema";
import { createPolicyCache, loadRolePolicy } from "./role-policy";

type PaseoConfigApi = PluginHandlerContext["paseo"];

function fakePaseo(config: unknown): PaseoConfigApi {
  return {
    config: { get: vi.fn().mockResolvedValue({ requestId: "r1", config }) },
  } as unknown as PaseoConfigApi;
}

const VALID_STORED_POLICY: RoleModelPolicy = {
  schemaVersion: 3,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude/opus"], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "leader", name: "leader", standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
  ],
  modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  enforceToolsOnClassifiedRoles: false,
  agentTypeMappings: { worker: "worker" },
  revision: "abc123",
};

describe("loadRolePolicy", () => {
  it("returns DEFAULT_POLICY (not fail-closed) when the key is missing", async () => {
    const paseo = fakePaseo({ providers: {} });

    const result = await loadRolePolicy(paseo);

    expect(result.malformed).toBe(false);
    expect(result.policy).toEqual(DEFAULT_POLICY);
  });

  it("parses a valid stored policy", async () => {
    const paseo = fakePaseo({ agentModelPolicy: VALID_STORED_POLICY });

    const result = await loadRolePolicy(paseo);

    expect(result.malformed).toBe(false);
    expect(result.policy).toEqual(VALID_STORED_POLICY);
  });

  it("migrates a stored v1 document off the leader account, reading the pool from the same config snapshot", async () => {
    // Shape of the live policy as of 2026-09-17: schemaVersion 1, every ref
    // written `claude/...`, and the pool leader's entry id literally `claude`.
    const paseo = fakePaseo({
      providers: {
        claude: { params: { accountPool: { role: "leader", priority: 1 } } },
        "claude-personal": { params: { accountPool: { role: "worker", priority: 1 } } },
      },
      agentModelPolicy: {
        schemaVersion: 1,
        roles: [
          { id: "worker", name: "worker", standard: true, aliases: [], models: ["claude/claude-sonnet-5"] },
          { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [] },
          { id: "advisor", name: "advisor", standard: true, aliases: [], models: ["claude/claude-opus-5", "codex/gpt-5.1"] },
        ],
        agentTypeMappings: { worker: "worker" },
        revision: "fcc9e0ec627c",
      },
    });

    const result = await loadRolePolicy(paseo);

    expect(result.malformed).toBe(false);
    expect(result.policy.schemaVersion).toBe(3);
    expect(result.policy.roles[0].models).toEqual(["claude-sonnet-5"]);
    expect(result.policy.roles[2].models).toEqual(["claude-opus-5", "codex/gpt-5.1"]);
    expect(result.policy.revision).toBe("fcc9e0ec627c");
  });

  it("fails closed and keeps the previous policy when the stored value is malformed", async () => {
    const paseo = fakePaseo({ agentModelPolicy: { schemaVersion: 3, roles: "not-an-array" } });

    const result = await loadRolePolicy(paseo, VALID_STORED_POLICY);

    expect(result.malformed).toBe(true);
    expect(result.policy).toEqual(VALID_STORED_POLICY);
    expect(result.error).toBeDefined();
  });

  it("falls back to DEFAULT_POLICY when malformed and there is no previous policy", async () => {
    const paseo = fakePaseo({ agentModelPolicy: { schemaVersion: 3, roles: "not-an-array" } });

    const result = await loadRolePolicy(paseo);

    expect(result.malformed).toBe(true);
    expect(result.policy).toEqual(DEFAULT_POLICY);
  });

  it("never throws when the config RPC rejects, and fails closed", async () => {
    const paseo = { config: { get: vi.fn().mockRejectedValue(new Error("daemon unreachable")) } } as unknown as PaseoConfigApi;

    const result = await loadRolePolicy(paseo, VALID_STORED_POLICY);

    expect(result.malformed).toBe(true);
    expect(result.policy).toEqual(VALID_STORED_POLICY);
    expect(result.error).toMatch(/daemon unreachable/);
  });
});

describe("createPolicyCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at DEFAULT_POLICY before the first load resolves", () => {
    const paseo = fakePaseo({});
    const cache = createPolicyCache(paseo, { intervalMs: 1000 });

    expect(cache.get()).toEqual(DEFAULT_POLICY);
    expect(cache.isMalformed()).toBe(false);
    cache.stop();
  });

  it("refreshes on interval ticks", async () => {
    const paseo = fakePaseo({ agentModelPolicy: VALID_STORED_POLICY });
    const cache = createPolicyCache(paseo, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(cache.get()).toEqual(VALID_STORED_POLICY);
    cache.stop();
  });

  it("refreshes immediately on forceRefresh without waiting for the interval", async () => {
    const paseo = fakePaseo({ agentModelPolicy: VALID_STORED_POLICY });
    const cache = createPolicyCache(paseo, { intervalMs: 60_000 });

    const before = cache.get();
    const result = await cache.forceRefresh();

    expect(before).toEqual(DEFAULT_POLICY);
    expect(result).toEqual(VALID_STORED_POLICY);
    cache.stop();
  });

  it("sees an external config.patch on the next forceRefresh", async () => {
    const configGet = vi.fn().mockResolvedValue({ requestId: "r1", config: {} });
    const paseo = { config: { get: configGet } } as unknown as PaseoConfigApi;
    const cache = createPolicyCache(paseo, { intervalMs: 60_000 });

    await cache.forceRefresh();
    expect(cache.get()).toEqual(DEFAULT_POLICY);

    configGet.mockResolvedValue({ requestId: "r2", config: { agentModelPolicy: VALID_STORED_POLICY } });
    await cache.forceRefresh();

    expect(cache.get()).toEqual(VALID_STORED_POLICY);
    cache.stop();
  });

  it("keeps serving the last-good policy and flags malformed when a later load breaks", async () => {
    const configGet = vi.fn().mockResolvedValue({ requestId: "r1", config: { agentModelPolicy: VALID_STORED_POLICY } });
    const paseo = { config: { get: configGet } } as unknown as PaseoConfigApi;
    const cache = createPolicyCache(paseo, { intervalMs: 60_000 });

    await cache.forceRefresh();
    expect(cache.isMalformed()).toBe(false);

    configGet.mockResolvedValue({ requestId: "r2", config: { agentModelPolicy: { schemaVersion: 1 } } });
    await cache.forceRefresh();

    expect(cache.isMalformed()).toBe(true);
    expect(cache.get()).toEqual(VALID_STORED_POLICY); // last good, never wiped
    cache.stop();
  });

  it("stop() clears the interval so no further refreshes happen", async () => {
    const paseo = fakePaseo({});
    const cache = createPolicyCache(paseo, { intervalMs: 1000 });
    cache.stop();

    const getSpy = (paseo.config.get as ReturnType<typeof vi.fn>);
    const callsAtStop = getSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(getSpy.mock.calls.length).toBe(callsAtStop);
  });
});
