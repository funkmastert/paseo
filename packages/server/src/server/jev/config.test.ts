import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import {
  createJevConfigReader,
  JEV_DEFAULT_EXCLUDE_CWDS,
  JEV_DEFAULT_EXCLUDE_REMOTES,
  JEV_DEFAULT_EXCLUDE_TEXT_MARKERS,
  JEV_MAX_REQUESTS_PER_SECOND,
  JEV_MIN_INPUT_USD_PER_MILLION,
  JEV_PROVIDER_DEFAULTS,
  jevConfigSection,
  jevConfigIssues,
  resolveJevConfig,
  resolveJevProvider,
} from "./config.js";

const TYPESAFE_KEY = "apikey_fake-typesafe-key-do-not-use";
const OPENROUTER_KEY = "sk-or-fake-openrouter-key-do-not-use";

const HOME = "/fake/home";

function capturingLogger(): { logger: pino.Logger; text: () => string } {
  let text = "";
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      },
    }),
  );
  return { logger, text: () => text };
}

const tempDirs: string[] = [];
function createTempPaseoHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-jev-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveJevConfig defaults", () => {
  const config = resolveJevConfig({}, { homeDir: HOME });

  test("master switch and provider default on", () => {
    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("openrouter");
    expect(config.model).toBe(JEV_PROVIDER_DEFAULTS.openrouter.model);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });

  test("envFile defaults under the given home", () => {
    expect(config.envFile).toBe(path.join(HOME, ".config/paseo/jev.env"));
  });

  test("lane and spend defaults", () => {
    expect(config.maxConcurrent).toBe(4);
    expect(config.maxRequestsPerSecond).toBe(10);
    expect(config.maxUsdPerDay).toBe(1);
    expect(config.inputUsdPerMillion).toBe(JEV_MIN_INPUT_USD_PER_MILLION);
  });

  // Tyler answered D7 on 2026-10-02: company code may go to JEV. Spelled out rather than compared
  // to the constants, so the decision is what the test pins.
  test("the D7 exclusion defaults exclude nothing", () => {
    expect(config.excludeCwds).toEqual([]);
    expect(config.excludeRemotes).toEqual([]);
    expect(config.excludeTextMarkers).toEqual([]);
    expect([
      JEV_DEFAULT_EXCLUDE_CWDS,
      JEV_DEFAULT_EXCLUDE_REMOTES,
      JEV_DEFAULT_EXCLUDE_TEXT_MARKERS,
    ]).toEqual([[], [], []]);
  });

  test("audit defaults", () => {
    expect(config.audit).toEqual({ enabled: true, maxBytes: 4_000_000, retainDays: 3 });
  });

  test("every feature with a shadow mode defaults shadow true (D6)", () => {
    expect(config.spawnHint.shadow).toBe(true);
    expect(config.remediationTriage.shadow).toBe(true);
    expect(config.notificationTriage.shadow).toBe(true);
    expect(config.compactionTiming.shadow).toBe(true);
    expect(config.stallJudgment.shadow).toBe(true);
  });

  test("agentTools has no shadow mode", () => {
    expect(config.agentTools.shadow).toBe(false);
  });

  test("feature timeouts", () => {
    expect(config.spawnHint.timeoutMs).toBe(1500);
    expect(config.notificationTriage.timeoutMs).toBe(3000);
    expect(config.remediationTriage.timeoutMs).toBe(5000);
    expect(config.agentTools.timeoutMs).toBe(8000);
    expect(config.compactionTiming.timeoutMs).toBe(5000);
    expect(config.stallJudgment.timeoutMs).toBe(5000);
  });

  test("spawnHint apply flags default off", () => {
    expect(config.spawnHint.applyHard).toBe(false);
    expect(config.spawnHint.applyRole).toBe(false);
  });

  test("spawnHint auditDeclared defaults on", () => {
    expect(config.spawnHint.auditDeclared).toBe(true);
  });

  test("agentTools lane defaults", () => {
    expect(config.agentTools.maxConcurrent).toBe(4);
    expect(config.agentTools.maxConcurrentPerCall).toBe(2);
    expect(config.agentTools.maxUsdPerDay).toBe(0.5);
    expect(config.agentTools.maxUsdPerAgentPerHour).toBe(0.05);
    expect(config.agentTools.assignShare).toBe(0.5);
  });

  test("compactionTiming defaults", () => {
    expect(config.compactionTiming.considerAtTokens).toBe(200_000);
    expect(config.compactionTiming.ceilingTokens).toBe(500_000);
    expect(config.compactionTiming.maxDeferrals).toBe(3);
    expect(config.compactionTiming.cutPoint).toBe(true);
  });

  test("stallJudgment defaults", () => {
    expect(config.stallJudgment.loopWatch).toBe(true);
  });
});

describe("resolveJevConfig provider selection", () => {
  test("typesafe provider picks the typesafe defaults", () => {
    const config = resolveJevConfig({ provider: "typesafe" }, { homeDir: HOME });
    expect(config.provider).toBe("typesafe");
    expect(config.model).toBe(JEV_PROVIDER_DEFAULTS.typesafe.model);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.typesafe.url);
  });

  test("an unknown provider falls back to openrouter", () => {
    const config = resolveJevConfig({ provider: "azure" }, { homeDir: HOME });
    expect(config.provider).toBe("openrouter");
  });

  test("no explicit provider and no key stays openrouter, not inferred", () => {
    const config = resolveJevConfig({}, { homeDir: HOME });
    expect(config.provider).toBe("openrouter");
    expect(config.providerInferred).toBe(false);
  });
});

describe("resolveJevProvider: inference from the key's prefix", () => {
  test("apikey_ infers typesafe", () => {
    expect(resolveJevProvider(undefined, TYPESAFE_KEY)).toEqual({
      provider: "typesafe",
      inferred: true,
    });
  });

  test("sk-or- infers openrouter", () => {
    expect(resolveJevProvider(undefined, OPENROUTER_KEY)).toEqual({
      provider: "openrouter",
      inferred: true,
    });
  });

  test("an unrecognized prefix keeps today's default, not inferred", () => {
    expect(resolveJevProvider(undefined, "some-other-key-shape")).toEqual({
      provider: "openrouter",
      inferred: false,
    });
  });

  test("no key keeps today's default, not inferred", () => {
    expect(resolveJevProvider(undefined, null)).toEqual({
      provider: "openrouter",
      inferred: false,
    });
  });

  test("an explicit provider wins over a key that would infer the other one", () => {
    expect(resolveJevProvider("openrouter", TYPESAFE_KEY)).toEqual({
      provider: "openrouter",
      inferred: false,
    });
    expect(resolveJevProvider("typesafe", OPENROUTER_KEY)).toEqual({
      provider: "typesafe",
      inferred: false,
    });
  });
});

describe("resolveJevConfig: provider inferred from the key end to end", () => {
  test("an apikey_ key with no explicit provider resolves the typesafe endpoint and model", () => {
    const config = resolveJevConfig({}, { homeDir: HOME, key: TYPESAFE_KEY });
    expect(config.provider).toBe("typesafe");
    expect(config.providerInferred).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.typesafe.url);
    expect(config.model).toBe(JEV_PROVIDER_DEFAULTS.typesafe.model);
  });

  test("an sk-or- key with no explicit provider resolves the openrouter endpoint and model", () => {
    const config = resolveJevConfig({}, { homeDir: HOME, key: OPENROUTER_KEY });
    expect(config.provider).toBe("openrouter");
    expect(config.providerInferred).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
    expect(config.model).toBe(JEV_PROVIDER_DEFAULTS.openrouter.model);
  });

  test("an explicit agents.jev.provider overrides inference both ways", () => {
    const staysOpenrouter = resolveJevConfig(
      { provider: "openrouter" },
      { homeDir: HOME, key: TYPESAFE_KEY },
    );
    expect(staysOpenrouter.provider).toBe("openrouter");
    expect(staysOpenrouter.providerInferred).toBe(false);

    const staysTypesafe = resolveJevConfig(
      { provider: "typesafe" },
      { homeDir: HOME, key: OPENROUTER_KEY },
    );
    expect(staysTypesafe.provider).toBe("typesafe");
    expect(staysTypesafe.providerInferred).toBe(false);
  });

  test("no key leaves resolution unchanged from today's behaviour", () => {
    const withKey = resolveJevConfig({}, { homeDir: HOME, key: null });
    const withoutKeyOption = resolveJevConfig({}, { homeDir: HOME });
    expect(withKey).toEqual(withoutKeyOption);
    expect(withKey.provider).toBe("openrouter");
    expect(withKey.providerInferred).toBe(false);
  });
});

describe("resolveJevConfig fallbacks for malformed values", () => {
  test("non-boolean enabled falls back to true", () => {
    expect(resolveJevConfig({ enabled: "yes" }, { homeDir: HOME }).enabled).toBe(true);
  });

  test("a non-positive maxConcurrent falls back to the default", () => {
    expect(resolveJevConfig({ maxConcurrent: -1 }, { homeDir: HOME }).maxConcurrent).toBe(4);
    expect(resolveJevConfig({ maxConcurrent: "many" }, { homeDir: HOME }).maxConcurrent).toBe(4);
  });

  test("a non-array excludeCwds falls back to the default", () => {
    expect(resolveJevConfig({ excludeCwds: "none" }, { homeDir: HOME }).excludeCwds).toEqual(
      JEV_DEFAULT_EXCLUDE_CWDS,
    );
  });

  test("an array with a non-string entry falls back to the default", () => {
    expect(
      resolveJevConfig({ excludeRemotes: ["ok", 5] }, { homeDir: HOME }).excludeRemotes,
    ).toEqual(JEV_DEFAULT_EXCLUDE_REMOTES);
  });

  test("a configured list turns the signal on, an empty array leaves it off", () => {
    expect(
      resolveJevConfig({ excludeTextMarkers: ["acmeinternal"] }, { homeDir: HOME })
        .excludeTextMarkers,
    ).toEqual(["acmeinternal"]);
    expect(
      resolveJevConfig({ excludeTextMarkers: [] }, { homeDir: HOME }).excludeTextMarkers,
    ).toEqual([]);
  });

  test("a configured list replaces the default rather than merging", () => {
    expect(
      resolveJevConfig({ excludeCwds: ["~/only-this"] }, { homeDir: HOME }).excludeCwds,
    ).toEqual(["~/only-this"]);
  });

  test("an empty envFile string falls back to the default", () => {
    const config = resolveJevConfig({ envFile: "" }, { homeDir: HOME });
    expect(config.envFile).toBe(path.join(HOME, ".config/paseo/jev.env"));
  });
});

describe("resolveJevConfig endpoint allowlist", () => {
  test("a valid https openrouter.ai override is accepted", () => {
    const config = resolveJevConfig(
      { endpointUrl: "https://openrouter.ai/api/alpha/decisions/v2" },
      { homeDir: HOME },
    );
    expect(config.endpointUrl).toBe("https://openrouter.ai/api/alpha/decisions/v2");
  });

  test("http: is rejected", () => {
    let rejected = false;
    const config = resolveJevConfig(
      { endpointUrl: "http://openrouter.ai/api/alpha/decisions" },
      { homeDir: HOME, onRejectedEndpoint: () => (rejected = true) },
    );
    expect(rejected).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });

  test("another host is rejected", () => {
    let rejected = false;
    const config = resolveJevConfig(
      { endpointUrl: "https://evil.example.com/api" },
      { homeDir: HOME, onRejectedEndpoint: () => (rejected = true) },
    );
    expect(rejected).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });

  test("a userinfo trick (https://openrouter.ai@evil.com) is rejected", () => {
    let rejected = false;
    const config = resolveJevConfig(
      { endpointUrl: "https://openrouter.ai@evil.com/api" },
      { homeDir: HOME, onRejectedEndpoint: () => (rejected = true) },
    );
    expect(rejected).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });

  test("a lookalike subdomain (evil.openrouter.ai.x.com) is rejected", () => {
    let rejected = false;
    const config = resolveJevConfig(
      { endpointUrl: "https://evil.openrouter.ai.x.com/api" },
      { homeDir: HOME, onRejectedEndpoint: () => (rejected = true) },
    );
    expect(rejected).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });

  test("an unparsable value is rejected", () => {
    let rejected = false;
    const config = resolveJevConfig(
      { endpointUrl: "not a url" },
      { homeDir: HOME, onRejectedEndpoint: () => (rejected = true) },
    );
    expect(rejected).toBe(true);
    expect(config.endpointUrl).toBe(JEV_PROVIDER_DEFAULTS.openrouter.url);
  });
});

describe("resolveJevConfig clamps", () => {
  test("maxRequestsPerSecond is clamped to at most 15", () => {
    expect(
      resolveJevConfig({ maxRequestsPerSecond: 1000 }, { homeDir: HOME }).maxRequestsPerSecond,
    ).toBe(JEV_MAX_REQUESTS_PER_SECOND);
  });

  test("maxRequestsPerSecond is clamped to at least 1", () => {
    expect(
      resolveJevConfig({ maxRequestsPerSecond: -5 }, { homeDir: HOME }).maxRequestsPerSecond,
    ).toBe(1);
  });

  test("inputUsdPerMillion never goes below the list price", () => {
    expect(
      resolveJevConfig({ inputUsdPerMillion: 0.001 }, { homeDir: HOME }).inputUsdPerMillion,
    ).toBe(JEV_MIN_INPUT_USD_PER_MILLION);
    expect(resolveJevConfig({ inputUsdPerMillion: 0 }, { homeDir: HOME }).inputUsdPerMillion).toBe(
      JEV_MIN_INPUT_USD_PER_MILLION,
    );
  });

  test("askJev: its own lane, no shadow, a deadline clamped to 1–30 s", () => {
    expect(resolveJevConfig({}, { homeDir: HOME }).askJev).toEqual({
      enabled: true,
      shadow: false,
      timeoutMs: 15_000,
      maxConcurrent: 2,
      maxUsdPerDay: 0.25,
    });
    expect(
      resolveJevConfig({ askJev: { timeoutMs: 600_000 } }, { homeDir: HOME }).askJev.timeoutMs,
    ).toBe(30_000);
    expect(
      resolveJevConfig({ askJev: { timeoutMs: 10 } }, { homeDir: HOME }).askJev.timeoutMs,
    ).toBe(1_000);
    expect(
      resolveJevConfig({ askJev: { maxUsdPerDay: -1, enabled: false } }, { homeDir: HOME }).askJev,
    ).toMatchObject({ enabled: false, maxUsdPerDay: 0.25 });
  });

  test("readCheck: shadow by default, live waits clamped to 300–2,000 ms, share in [0, 1]", () => {
    expect(resolveJevConfig({}, { homeDir: HOME }).readCheck).toEqual({
      enabled: true,
      shadow: true,
      timeoutMs: 5000,
      minTokens: 2000,
      liveMinTokens: 8000,
      liveTimeoutMs: 1000,
      liveShare: 0.5,
      maxDeniesPerAgentPerHour: 5,
      maxConcurrent: 2,
      maxUsdPerDay: 0.25,
    });
    const clamped = (readCheck: Record<string, unknown>) =>
      resolveJevConfig({ readCheck }, { homeDir: HOME }).readCheck;
    expect(clamped({ liveTimeoutMs: 60_000 }).liveTimeoutMs).toBe(2000);
    expect(clamped({ liveTimeoutMs: 1 }).liveTimeoutMs).toBe(300);
    expect(clamped({ liveShare: 3 }).liveShare).toBe(1);
    expect(clamped({ minTokens: -5, shadow: false }).minTokens).toBe(2000);
    expect(clamped({ shadow: false }).shadow).toBe(false);
  });

  test("readCheck keys pass the schema; an unknown one does not", () => {
    expect(jevConfigIssues({ readCheck: { shadow: false, liveShare: 0.5 } })).toEqual([]);
    expect(jevConfigIssues({ readCheck: { deny: true } })).toEqual([
      "agents.jev.readCheck: unknown key(s) deny",
    ]);
  });

  test("agentTools.assignShare is clamped into [0, 1]", () => {
    expect(
      resolveJevConfig({ agentTools: { assignShare: 5 } }, { homeDir: HOME }).agentTools
        .assignShare,
    ).toBe(1);
    expect(
      resolveJevConfig({ agentTools: { assignShare: -1 } }, { homeDir: HOME }).agentTools
        .assignShare,
    ).toBe(0);
    expect(
      resolveJevConfig({ agentTools: { assignShare: 0 } }, { homeDir: HOME }).agentTools
        .assignShare,
    ).toBe(0);
  });
});

describe("jevConfigSection", () => {
  test("reads agents.jev out of a parsed config", () => {
    expect(jevConfigSection({ agents: { jev: { enabled: false } } })).toEqual({ enabled: false });
  });

  test("answers undefined when absent", () => {
    expect(jevConfigSection({ agents: {} })).toBeUndefined();
    expect(jevConfigSection(null)).toBeUndefined();
  });
});

describe("createJevConfigReader", () => {
  test("defaults are used when config.json does not exist", () => {
    const { logger } = capturingLogger();
    const paseoHome = createTempPaseoHome();
    const reader = createJevConfigReader({ paseoHome, homeDir: HOME, logger });
    const result = reader.read();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.enabled).toBe(true);
  });

  test("answers config-unreadable when config.json cannot be read", () => {
    const { logger } = capturingLogger();
    const paseoHome = createTempPaseoHome();
    writeFileSync(path.join(paseoHome, "config.json"), "{ not json", "utf8");
    const reader = createJevConfigReader({ paseoHome, homeDir: HOME, logger });
    expect(reader.read()).toEqual({ ok: false, reason: "config-unreadable" });
  });

  test("caches the result within the TTL and re-reads after it", () => {
    const { logger } = capturingLogger();
    const paseoHome = createTempPaseoHome();
    let time = 1_000;
    let reads = 0;
    const readRaw = () => {
      reads += 1;
      return {
        rawConfig: { agents: { jev: { maxConcurrent: 4 } } } as Record<string, unknown>,
        rawConfigError: null,
      };
    };
    const reader = createJevConfigReader({
      paseoHome,
      homeDir: HOME,
      logger,
      now: () => time,
      readRaw,
    });
    reader.read();
    reader.read();
    expect(reads).toBe(1);
    time += 5_001;
    reader.read();
    expect(reads).toBe(2);
  });

  test("out-of-range values of the right type are clamped or ignored, and JEV stays on", () => {
    const { logger } = capturingLogger();
    const readRaw = () => ({
      rawConfig: {
        agents: {
          jev: {
            maxRequestsPerSecond: 20,
            maxConcurrent: 2.5,
            spawnHint: { timeoutMs: 0 },
            agentTools: { shadow: true },
            askJev: { shadow: true, timeoutMs: 120_000 },
          },
        },
      } as Record<string, unknown>,
      rawConfigError: null,
    });
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
    });
    const result = reader.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.maxRequestsPerSecond).toBe(15);
    expect(result.config.maxConcurrent).toBe(2);
    expect(result.config.spawnHint.timeoutMs).toBe(1500);
    expect(result.config.agentTools.shadow).toBe(false);
    expect(result.config.askJev).toMatchObject({ shadow: false, timeoutMs: 30_000 });
  });

  test.each([
    ["a string where a boolean goes", { enabled: "false" }, "agents.jev.enabled"],
    ["a string where a number goes", { maxConcurrent: "4" }, "agents.jev.maxConcurrent"],
    ["an unknown provider", { provider: "typsafe" }, "agents.jev.provider"],
    ["an unknown key", { maxConcurent: 4 }, "agents.jev"],
  ])("%s turns JEV off and logs the path once, never the value", (_name, jev, where) => {
    const { logger, text } = capturingLogger();
    const readRaw = () => ({
      rawConfig: { agents: { jev } } as Record<string, unknown>,
      rawConfigError: null,
    });
    let time = 0;
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
      now: () => time,
      ttlMs: 1,
    });
    expect(reader.read()).toEqual({ ok: false, reason: "config-unreadable" });
    time += 2;
    reader.read();
    const lines = text()
      .split("\n")
      .filter((line) => line.includes("does not match"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(where);
    expect(lines[0]).not.toContain("typsafe");
  });

  test("resolveKey feeds provider inference through the cached reader", () => {
    const { logger } = capturingLogger();
    const readRaw = () => ({
      rawConfig: { agents: { jev: {} } } as Record<string, unknown>,
      rawConfigError: null,
    });
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
      resolveKey: () => TYPESAFE_KEY,
    });
    const result = reader.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.provider).toBe("typesafe");
    expect(result.config.providerInferred).toBe(true);
  });

  test("an explicit provider wins over resolveKey's inference through the reader", () => {
    const { logger } = capturingLogger();
    const readRaw = () => ({
      rawConfig: { agents: { jev: { provider: "openrouter" } } } as Record<string, unknown>,
      rawConfigError: null,
    });
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
      resolveKey: () => TYPESAFE_KEY,
    });
    const result = reader.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.provider).toBe("openrouter");
    expect(result.config.providerInferred).toBe(false);
  });

  test("with no resolveKey, the reader infers nothing (today's behaviour)", () => {
    const { logger } = capturingLogger();
    const readRaw = () => ({
      rawConfig: { agents: { jev: {} } } as Record<string, unknown>,
      rawConfigError: null,
    });
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
    });
    const result = reader.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.provider).toBe("openrouter");
    expect(result.config.providerInferred).toBe(false);
  });

  test("the key resolveKey returns never appears in a log line", () => {
    const { logger, text } = capturingLogger();
    const readRaw = () => ({
      rawConfig: {
        agents: { jev: { endpointUrl: "https://evil.example.com/steal" } },
      } as Record<string, unknown>,
      rawConfigError: null,
    });
    const reader = createJevConfigReader({
      paseoHome: createTempPaseoHome(),
      homeDir: HOME,
      logger,
      readRaw,
      resolveKey: () => TYPESAFE_KEY,
    });
    reader.read();
    expect(text()).not.toContain(TYPESAFE_KEY);
  });

  test("logs one line per distinct rejected endpoint value, naming no path or query", () => {
    const { logger, text } = capturingLogger();
    const paseoHome = createTempPaseoHome();
    const readRaw = () => ({
      rawConfig: {
        agents: { jev: { endpointUrl: "https://evil.example.com/steal?token=abc" } },
      } as Record<string, unknown>,
      rawConfigError: null,
    });
    let time = 0;
    const reader = createJevConfigReader({
      paseoHome,
      homeDir: HOME,
      logger,
      readRaw,
      now: () => time,
      ttlMs: 1,
    });
    reader.read();
    time += 2;
    reader.read();
    const lines = text()
      .split("\n")
      .filter((line) => line.includes("endpointUrl") && line.includes("rejected"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("steal");
    expect(lines[0]).not.toContain("token=abc");
  });
});
