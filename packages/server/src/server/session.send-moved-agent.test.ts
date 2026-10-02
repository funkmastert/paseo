import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentRequests } from "./agent/requests/index.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { Session, type SessionOptions } from "./session.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import {
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";

type SendResponse = Extract<SessionOutboundMessage, { type: "send_agent_message_response" }>;

interface MovedAgentHarness {
  session: Session;
  agentManager: AgentManager;
  createAgent(): Promise<string>;
  retire(agentId: string, successorId: string): Promise<void>;
  send(agentId: string, messageId?: string): Promise<SendResponse["payload"]>;
  promptedAgentIds(): string[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A Session over a real manager, storage and request journal: the path the app and CLI send on. */
function createHarness(): MovedAgentHarness {
  const workdir = mkdtempSync(path.join(tmpdir(), "session-send-moved-"));
  const logger = createTestLogger();
  const agentIdBySession = new Map<string, string>();
  const prompted: string[] = [];
  const agentStorage = new AgentStorage(path.join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: {
      codex: createTestAgentClient("codex", {
        onStartTurn: (_prompt, sessionId) => {
          prompted.push(agentIdBySession.get(sessionId) ?? sessionId);
        },
      }),
    },
    registry: agentStorage,
    logger,
  });
  const emitted: SessionOutboundMessage[] = [];
  const session = new Session({
    agentRequests: new AgentRequests(path.join(workdir, "requests")),
    clientId: "test-client",
    serverId: "test-server",
    permissions: OWNER_PERMISSIONS,
    appVersion: null,
    onMessage: (message) => emitted.push(message),
    logger,
    downloadTokenStore: asDownloadTokenStore(),
    pushNotifications: asPushNotifications(),
    paseoHome: path.join(workdir, "paseo-home"),
    agentManager,
    agentStorage,
    projectRegistry: new FileBackedProjectRegistry(path.join(workdir, "projects.json"), logger),
    workspaceRegistry: new FileBackedWorkspaceRegistry(
      path.join(workdir, "workspaces.json"),
      logger,
    ),
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager({ scheduleRefreshForCwd: () => {} }),
    workspaceGitService: createNoopWorkspaceGitService(),
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
    workspaceAutoName: createStub<SessionOptions["workspaceAutoName"]>({}),
    providerUsageService: createStub<SessionOptions["providerUsageService"]>({}),
  });
  cleanups.push(async () => {
    await session.cleanup();
    for (const agent of agentManager.listAgents()) {
      await agentManager.closeAgent(agent.id).catch(() => undefined);
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  let requestCount = 0;
  return {
    session,
    agentManager,
    async createAgent() {
      const agent = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      const sessionId = agent.persistence?.sessionId;
      if (sessionId) agentIdBySession.set(sessionId, agent.id);
      return agent.id;
    },
    async retire(agentId, successorId) {
      await agentManager.updateAgentMetadata(agentId, {
        labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: successorId },
      });
    },
    async send(agentId, messageId) {
      requestCount += 1;
      const requestId = `req-send-${requestCount}`;
      await session.handleMessage({
        type: "send_agent_message_request",
        requestId,
        agentId,
        text: "where did you go?",
        ...(messageId ? { messageId } : {}),
      });
      const response = emitted.find(
        (message): message is SendResponse =>
          message.type === "send_agent_message_response" && message.payload.requestId === requestId,
      );
      if (!response) throw new Error(`No send_agent_message_response for ${requestId}`);
      return response.payload;
    },
    promptedAgentIds: () => prompted,
  };
}

describe("send_agent_message_request to an agent account failover moved", () => {
  test("delivers to where the conversation lives now and says so", async () => {
    const harness = createHarness();
    const retired = await harness.createAgent();
    const successor = await harness.createAgent();
    await harness.retire(retired, successor);
    await harness.agentManager.closeAgent(retired);

    // With a message id the send goes through the request journal, which loads its target first.
    const payload = await harness.send(retired, "message-1");

    expect(payload).toMatchObject({
      agentId: retired,
      accepted: true,
      error: null,
      deliveredToAgentId: successor,
    });
    expect(harness.promptedAgentIds()).toEqual([successor]);
    // The handle it left is not resumed on the capped account.
    expect(harness.agentManager.getAgent(retired)).toBeNull();
  });

  test("leaves deliveredToAgentId out when the agent never moved", async () => {
    const harness = createHarness();
    const agent = await harness.createAgent();

    const payload = await harness.send(agent);

    expect(payload).toEqual({
      requestId: expect.any(String),
      agentId: agent,
      accepted: true,
      error: null,
    });
    expect(harness.promptedAgentIds()).toEqual([agent]);
  });

  test("refuses a move loop with an error naming it, and sends nothing", async () => {
    const harness = createHarness();
    const first = await harness.createAgent();
    const second = await harness.createAgent();
    await harness.retire(first, second);
    await harness.retire(second, first);

    const payload = await harness.send(first, "message-loop");

    expect(payload.accepted).toBe(false);
    expect(payload.error).toContain(`${first} → ${second} → ${first}`);
    expect(harness.promptedAgentIds()).toEqual([]);
  });
});
