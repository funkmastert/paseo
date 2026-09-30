import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentStorage } from "../agent-storage.js";
import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../agent-manager.js";
import { RestartRecoveryService } from "./service.js";

function fakeAgentManager(): AgentManager {
  return {
    getProviderAvailability: async () => ({ available: true }),
    canProviderResumeSession: async () => null,
    getAgent: () => undefined,
  } as unknown as AgentManager;
}

function fakeManagedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  const now = new Date("2026-09-29T20:00:00.000Z");
  return {
    id: "agent-cut-off",
    provider: "claude",
    cwd: "/tmp/does-not-matter",
    workspaceId: undefined,
    session: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { provider: "claude", cwd: "/tmp/does-not-matter", modeId: "plan", model: "gpt-5.1" },
    lifecycle: "running",
    createdAt: now,
    updatedAt: now,
    availableModes: [],
    currentModeId: "plan",
    pendingPermissions: new Map(),
    activeForegroundTurnId: null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    attention: { requiresAttention: false },
    runtimeInfo: { provider: "claude", sessionId: "session-1", model: "gpt-5.1", modeId: "plan" },
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: now,
    ...overrides,
  } as unknown as ManagedAgent;
}

describe("RestartRecoveryService previous-shutdown wiring", () => {
  let tmpDir: string;
  let storage: AgentStorage;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "restart-recovery-shutdown-info-"));
    storage = new AgentStorage(path.join(tmpDir, "agents"), createTestLogger());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a boot after a supervisor stop reports bozeo_quit with the time", async () => {
    await storage.applySnapshot(fakeManagedAgent());
    await storage.updateRunMarker("agent-cut-off", () => ({
      startedAt: "2026-09-29T19:30:00.000Z",
    }));

    const service = await RestartRecoveryService.capture({
      agentStorage: storage,
      agentManager: fakeAgentManager(),
      config: { mode: "plan" },
      logger: createTestLogger(),
      readPreviousShutdown: async () => ({
        reason: "bozeo_quit",
        at: "2026-09-29T20:49:10.000Z",
        detail: "shutdown budget exhausted",
      }),
    });

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const plan = await service.getPlan();
    expect(plan.previousShutdown).toBe("clean");
    expect(plan.previousShutdownInfo).toEqual({
      reason: "bozeo_quit",
      at: "2026-09-29T20:49:10.000Z",
      detail: "shutdown budget exhausted",
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.stoppedAt).toBe("2026-09-29T20:49:10.000Z");
  });

  test("with no readPreviousShutdown wired, it reads as unknown", async () => {
    await storage.applySnapshot(fakeManagedAgent({ id: "agent-unwired" }));
    await storage.updateRunMarker("agent-unwired", () => ({
      startedAt: "2026-09-29T19:30:00.000Z",
    }));

    const service = await RestartRecoveryService.capture({
      agentStorage: storage,
      agentManager: fakeAgentManager(),
      config: { mode: "plan" },
      logger: createTestLogger(),
    });

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const plan = await service.getPlan();
    expect(plan.previousShutdown).toBe("unknown");
    expect(plan.previousShutdownInfo).toEqual({ reason: "unknown", at: null });
    expect(plan.entries[0]?.stoppedAt).toBeNull();
  });
});
