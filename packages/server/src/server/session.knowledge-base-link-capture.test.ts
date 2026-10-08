import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createTestLogger } from "../test-utils/test-logger.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentRequests } from "./agent/requests/index.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import type { CapturedLink } from "./knowledge-base/link-capture.js";
import { setLinkCaptureSink } from "./knowledge-base/link-capture.js";
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

interface Harness {
  session: Session;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: ReturnType<typeof createTestLogger>;
  createAgent(): Promise<string>;
  send(agentId: string, text: string): Promise<SendResponse["payload"]>;
}

/** The sink is a module-level seam; every test resets it so none leak into the next. */
afterEach(() => {
  setLinkCaptureSink(null);
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Lets the fire-and-forget capture sink dispatch (a few microtasks) run before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(): Harness {
  const workdir = mkdtempSync(path.join(tmpdir(), "session-link-capture-"));
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(path.join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { codex: createTestAgentClient("codex") },
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
    agentStorage,
    logger,
    async createAgent() {
      const agent = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      return agent.id;
    },
    async send(agentId, text) {
      requestCount += 1;
      const requestId = `req-send-${requestCount}`;
      await session.handleMessage({
        type: "send_agent_message_request",
        requestId,
        agentId,
        text,
      });
      const response = emitted.find(
        (message): message is SendResponse =>
          message.type === "send_agent_message_response" && message.payload.requestId === requestId,
      );
      if (!response) throw new Error(`No send_agent_message_response for ${requestId}`);
      return response.payload;
    },
  };
}

describe("link capture on the app's human send path (U3, KTD-8)", () => {
  test("a human send_agent_message_request hands the link to the installed sink", async () => {
    const harness = createHarness();
    const agentId = await harness.createAgent();
    const calls: Array<{ agentId: string; link: CapturedLink }> = [];
    setLinkCaptureSink((sunk, link) => {
      calls.push({ agentId: sunk, link });
    });

    const payload = await harness.send(
      agentId,
      "kicking off the checkout redesign: https://www.figma.com/design/fake123/Checkout",
    );
    await flush();

    expect(payload.accepted).toBe(true);
    expect(calls).toEqual([
      {
        agentId,
        link: {
          url: "https://www.figma.com/design/fake123/Checkout",
          kind: "figma",
          host: "www.figma.com",
        },
      },
    ]);
  });

  test("an agent-to-agent prompt (sendPromptToAgent, bypassing the session) hands none", async () => {
    const harness = createHarness();
    const agentId = await harness.createAgent();
    const calls: Array<{ agentId: string; link: CapturedLink }> = [];
    setLinkCaptureSink((sunk, link) => {
      calls.push({ agentId: sunk, link });
    });

    // The shape an MCP tool (child-to-parent, parent-to-child) uses to deliver a prompt: it never
    // goes through session.ts, which is where capture is wired (KTD-8).
    await sendPromptToAgent({
      agentManager: harness.agentManager,
      agentStorage: harness.agentStorage,
      agentId,
      prompt: "see https://www.figma.com/design/fake123/FromAnotherAgent",
      logger: harness.logger,
    });
    await flush();

    expect(calls).toEqual([]);
  });

  test("a sink that throws does not fail the send", async () => {
    const harness = createHarness();
    const agentId = await harness.createAgent();
    setLinkCaptureSink(() => {
      throw new Error("sink exploded");
    });

    const payload = await harness.send(
      agentId,
      "see https://www.figma.com/design/fake123/Checkout",
    );
    await flush();

    expect(payload.accepted).toBe(true);
  });
});
