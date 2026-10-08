import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
} from "../managed-processes/managed-processes.js";
import {
  BasicMemorySidecar,
  basicMemoryConfigDir,
  type BasicMemorySidecarClock,
  type BasicMemorySidecarOptions,
  type BasicMemorySidecarStatus,
} from "./basic-memory-sidecar.js";
import type { ResolvedKnowledgeBaseConfig } from "./config.js";
import {
  linkNodeAs,
  writeFakeBasicMemory,
  type FakeBasicMemory,
} from "./test-utils/fake-basic-memory.js";

const tempDirs: string[] = [];
const sidecars: BasicMemorySidecar[] = [];

afterEach(async () => {
  while (sidecars.length > 0) await sidecars.pop()?.stop();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-kb-sidecar-"));
  tempDirs.push(dir);
  return dir;
}

/** Records the backoff timers the sidecar asks for; a test fires them. */
class ManualClock implements BasicMemorySidecarClock {
  current = 1_000_000;
  private readonly timers: Array<{ delayMs: number; callback: () => void; live: boolean }> = [];

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer = { delayMs, callback, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  pendingDelays(): number[] {
    return this.timers.filter((timer) => timer.live).map((timer) => timer.delayMs);
  }

  fireNext(): void {
    const timer = this.timers.find((entry) => entry.live);
    if (!timer) throw new Error("No timer is pending");
    timer.live = false;
    this.current += timer.delayMs;
    timer.callback();
  }
}

class MemoryProcessRegistry implements ManagedProcessRegistry {
  readonly records = new Map<string, ManagedProcessRecord>();
  private next = 0;

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    this.next += 1;
    const record: ManagedProcessRecord = {
      ...input,
      id: `record-${this.next}`,
      metadata: input.metadata ?? {},
      identity: { commandLine: null, startedAt: null },
      createdAt: new Date(0).toISOString(),
    };
    this.records.set(record.id, record);
    return record;
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(): Promise<ManagedProcessRecord[]> {
    return [...this.records.values()];
  }

  async reapStale() {
    return { checked: 0, dead: 0, mismatched: 0, removed: 0, terminated: 0, errors: [] };
  }
}

interface Harness {
  sidecar: BasicMemorySidecar;
  clock: ManualClock;
  registry: MemoryProcessRegistry;
  notesDir: string;
  fake: FakeBasicMemory;
  config: ResolvedKnowledgeBaseConfig;
}

function createHarness(options: Partial<BasicMemorySidecarOptions> = {}): Harness {
  const root = tempDir();
  const fake = writeFakeBasicMemory(path.join(root, "bin"));
  const notesDir = path.join(root, "knowledge");
  const clock = new ManualClock();
  const registry = new MemoryProcessRegistry();
  const sidecar = new BasicMemorySidecar({
    logger: createTestLogger(),
    clock,
    managedProcesses: registry,
    fallbackBinDirs: [],
    ...options,
  });
  sidecars.push(sidecar);
  return {
    sidecar,
    clock,
    registry,
    notesDir,
    fake,
    config: {
      enabled: true,
      notesDir,
      basicMemory: { command: fake.command, semanticSearch: true },
    },
  };
}

async function waitForState<S extends BasicMemorySidecarStatus["state"]>(
  sidecar: BasicMemorySidecar,
  state: S,
): Promise<Extract<BasicMemorySidecarStatus, { state: S }>> {
  const deadline = Date.now() + 20_000;
  while (sidecar.getStatus().state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`Still ${sidecar.getStatus().state}, waiting for ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return sidecar.getStatus() as Extract<BasicMemorySidecarStatus, { state: S }>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitServer(sidecar: BasicMemorySidecar): Promise<void> {
  await sidecar.callTool({ name: "exit", arguments: {} }, { timeoutMs: 5_000 }).catch(() => {
    // The process may close the pipe before the reply arrives.
  });
}

function runningPid(sidecar: BasicMemorySidecar): number {
  const status = sidecar.getStatus();
  if (status.state !== "running" || status.pid === null) {
    throw new Error(`Expected a running server, got ${status.state}`);
  }
  return status.pid;
}

describe("BasicMemorySidecar", () => {
  test("a missing binary reports missing with a setup hint and does not retry", async () => {
    const { sidecar, clock, config } = createHarness();
    const absent = path.join(tempDir(), "basic-memory");

    await sidecar.applyConfig({
      ...config,
      basicMemory: { ...config.basicMemory, command: absent },
    });

    expect(sidecar.getStatus()).toEqual({
      state: "missing",
      command: absent,
      hint: expect.stringContaining("paseo kb setup"),
    });
    expect(clock.pendingDelays()).toEqual([]);
  });

  test("applying the config again after setup finds the binary and starts", async () => {
    const { sidecar, config } = createHarness();
    const binDir = path.join(tempDir(), "later");
    const command = path.join(
      binDir,
      process.platform === "win32" ? "basic-memory.cmd" : "basic-memory",
    );
    const missing = { ...config, basicMemory: { ...config.basicMemory, command } };
    await sidecar.applyConfig(missing);
    expect(sidecar.getStatus().state).toBe("missing");

    writeFakeBasicMemory(binDir);
    await sidecar.applyConfig(missing);

    expect(sidecar.getStatus().state).toBe("running");
  });

  test("starts the server with the lockdown environment and none of the daemon's secrets", async () => {
    const { sidecar, config, notesDir, fake, registry } = createHarness({
      baseEnv: {
        ...process.env,
        PASEO_JEV_API_KEY: "fake-jev-key-do-not-use",
        BASIC_MEMORY_CLOUD_API_KEY: "fake-cloud-key-do-not-use",
        BASIC_MEMORY_HOME: "/somewhere/else",
      },
    });

    await sidecar.applyConfig(config);

    expect(sidecar.getStatus()).toMatchObject({ state: "running", version: "0.23.2" });
    const configDir = basicMemoryConfigDir(notesDir);
    const result = (await sidecar.callTool(
      {
        name: "env",
        arguments: {
          names: [
            "BASIC_MEMORY_CONFIG_DIR",
            "BASIC_MEMORY_HOME",
            "BASIC_MEMORY_FORCE_LOCAL",
            "BASIC_MEMORY_CLOUD_MODE",
            "BASIC_MEMORY_AUTO_UPDATE",
            "BASIC_MEMORY_NO_PROMOS",
            "BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC",
            "BASIC_MEMORY_DISABLE_PERMALINKS",
            "BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED",
            "FASTMCP_CHECK_FOR_UPDATES",
            "BASIC_MEMORY_CLOUD_API_KEY",
            "PASEO_JEV_API_KEY",
          ],
        },
      },
      { timeoutMs: 5_000 },
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      BASIC_MEMORY_CONFIG_DIR: configDir,
      BASIC_MEMORY_HOME: path.join(configDir, "default-project"),
      BASIC_MEMORY_FORCE_LOCAL: "true",
      BASIC_MEMORY_CLOUD_MODE: "false",
      BASIC_MEMORY_AUTO_UPDATE: "false",
      BASIC_MEMORY_NO_PROMOS: "true",
      BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC: "false",
      BASIC_MEMORY_DISABLE_PERMALINKS: "true",
      BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: "true",
      FASTMCP_CHECK_FOR_UPDATES: "off",
      BASIC_MEMORY_CLOUD_API_KEY: null,
      PASEO_JEV_API_KEY: null,
    });
    expect(fake.calls().flatMap((call) => (call.argv ? [call.argv] : []))).toEqual([
      ["--version"],
      ["project", "add", "knowledge", notesDir],
      ["mcp", "--project", "knowledge"],
    ]);
    expect(new Set(fake.calls().map((call) => call.cwd))).toEqual(
      new Set([realpathSync(configDir)]),
    );
    expect([...registry.records.values()].map((record) => record.owner)).toEqual([
      { provider: "knowledge-base", kind: "basic-memory" },
    ]);
  });

  test("applying the same config while running keeps the same process", async () => {
    const { sidecar, config } = createHarness();
    await sidecar.applyConfig(config);
    const pid = runningPid(sidecar);

    await sidecar.applyConfig({ ...config });

    expect(runningPid(sidecar)).toBe(pid);
  });

  test("a server that exits restarts after 2 s, then 4 s, and 60 s up resets the delay", async () => {
    const { sidecar, clock, config } = createHarness();
    await sidecar.applyConfig(config);
    const firstPid = runningPid(sidecar);

    await exitServer(sidecar);
    expect(await waitForState(sidecar, "backoff")).toMatchObject({ delayMs: 2_000, attempt: 1 });
    expect(clock.pendingDelays()).toEqual([2_000]);
    clock.fireNext();
    await waitForState(sidecar, "running");
    expect(runningPid(sidecar)).not.toBe(firstPid);

    await exitServer(sidecar);
    expect(await waitForState(sidecar, "backoff")).toMatchObject({ delayMs: 4_000, attempt: 2 });
    clock.fireNext();
    await waitForState(sidecar, "running");

    clock.current += 60_000;
    await exitServer(sidecar);
    expect(await waitForState(sidecar, "backoff")).toMatchObject({ delayMs: 2_000 });
  });

  test("a start that fails goes to backoff with the server's last stderr lines", async () => {
    const { sidecar, clock, config, fake } = createHarness();
    fake.failStarts(true);

    await sidecar.applyConfig(config);

    const status = sidecar.getStatus();
    expect(status).toMatchObject({ state: "backoff", delayMs: 2_000 });
    expect(status.state === "backoff" ? status.stderrTail : []).toContain(
      "fake: database is locked",
    );
    fake.failStarts(false);
    clock.fireNext();
    await waitForState(sidecar, "running");
  });

  test("disabling through a config reload stops the child and records disabled", async () => {
    const { sidecar, config, registry } = createHarness();
    await sidecar.applyConfig(config);
    const pid = runningPid(sidecar);

    await sidecar.applyConfig({ ...config, enabled: false });

    expect(sidecar.getStatus()).toEqual({ state: "disabled" });
    expect(isAlive(pid)).toBe(false);
    expect(registry.records.size).toBe(0);
  });

  test("stop leaves no process behind and ignores later config", async () => {
    const { sidecar, config, registry, clock } = createHarness();
    await sidecar.applyConfig(config);
    const pid = runningPid(sidecar);

    await sidecar.stop();
    await sidecar.applyConfig(config);

    expect(isAlive(pid)).toBe(false);
    expect(sidecar.getStatus()).toEqual({ state: "disabled" });
    expect(registry.records.size).toBe(0);
    expect(clock.pendingDelays()).toEqual([]);
  });

  test.each([0, 1])(
    "a project that already exists does not block the start (exit code %i)",
    async (exitCode) => {
      const { sidecar, config, notesDir, fake } = createHarness();
      const configDir = basicMemoryConfigDir(notesDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ projects: { knowledge: { path: notesDir } } }),
      );
      fake.setExistsExitCode(exitCode);

      await sidecar.applyConfig(config);

      expect(sidecar.getStatus().state).toBe("running");
      expect(fake.calls().some((call) => call.argv?.[1] === "remove")).toBe(false);
    },
  );

  test("a notes folder moved on disk is registered again at its new path", async () => {
    const { sidecar, config, notesDir, fake } = createHarness();
    const configDir = basicMemoryConfigDir(notesDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ projects: { knowledge: { path: path.join(tempDir(), "old-place") } } }),
    );

    await sidecar.applyConfig(config);

    expect(sidecar.getStatus().state).toBe("running");
    expect(
      fake.calls().flatMap((call) => (call.argv?.[0] === "project" ? [call.argv] : [])),
    ).toEqual([
      ["project", "add", "knowledge", notesDir],
      ["project", "remove", "knowledge"],
      ["project", "add", "knowledge", notesDir],
    ]);
    const registered = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")) as {
      projects: Record<string, { path: string }>;
    };
    expect(registered.projects["knowledge"]?.path).toBe(notesDir);
  });

  test("a bare command name is found in uv's tool directory when PATH lacks it", async () => {
    const fallback = writeFakeBasicMemory(path.join(tempDir(), "uv bin"), "basic-memory-kb-fake");
    const { sidecar, config } = createHarness({ fallbackBinDirs: [fallback.binDir] });

    await sidecar.applyConfig({
      ...config,
      basicMemory: { ...config.basicMemory, command: "basic-memory-kb-fake" },
    });

    expect(sidecar.getStatus().state).toBe("running");
  });

  // The Windows CI job runs this against an `.exe`; elsewhere it is the same path with spaces.
  test("an executable path with spaces starts without a shell", async () => {
    const { sidecar, config, notesDir, fake } = createHarness();
    const command = linkNodeAs(path.join(tempDir(), "Basic Memory Tools"));
    fake.writeEntryScripts(basicMemoryConfigDir(notesDir));

    await sidecar.applyConfig({ ...config, basicMemory: { ...config.basicMemory, command } });

    // Node answers `--version` itself, so there is no Basic Memory version to report.
    expect(sidecar.getStatus()).toMatchObject({ state: "running", version: null });
    expect(fake.calls().map((call) => call.argv)).toEqual([
      ["project", "add", "knowledge", notesDir],
      ["mcp", "--project", "knowledge"],
    ]);
  });
});
