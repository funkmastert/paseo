import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  SteerActiveTurnOptions,
} from "./agent-sdk-types.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { findPerDirMcpServer } from "../mcp-gateway/per-dir-stdio.js";
import { createAllClients, wrapSessionProvider } from "./provider-registry.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "steerActiveTurn",
  "listCommands",
  "getContextUsage",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly id = "session-1";
  readonly capabilities = CAPABILITIES;
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  async steerActiveTurn(_prompt: AgentPromptInput, options: SteerActiveTurnOptions) {
    this.recordedCalls.push(`steerActiveTurn:${options.expectedTurnId}`);
    return { status: "accepted" as const };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async getContextUsage() {
    this.recordedCalls.push("getContextUsage");
    return null;
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    // A derived provider (every account-pool account) that drops this steers nothing: the
    // manager treats the steer as unavailable and interrupts the running turn instead.
    await expect(
      wrapped.steerActiveTurn?.("follow-up", { expectedTurnId: "turn-1" }),
    ).resolves.toEqual({ status: "accepted" });
    await wrapped.listCommands?.();
    await wrapped.getContextUsage?.({ allowStart: false });
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.recordedCalls).toEqual([
      "steerActiveTurn:turn-1",
      "listCommands",
      "getContextUsage",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
});

describe("wrapClientProvider", () => {
  const originalConfigDirVar = process.env.PASEO_TEST_ACCOUNTS_HOME;
  const tempDirs: string[] = [];

  function createAccountDir(name: string, servers: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), `paseo-claude-account-${name}-`));
    tempDirs.push(dir);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: servers }));
    return dir;
  }

  afterEach(() => {
    if (originalConfigDirVar === undefined) {
      delete process.env.PASEO_TEST_ACCOUNTS_HOME;
    } else {
      process.env.PASEO_TEST_ACCOUNTS_HOME = originalConfigDirVar;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a derived claude provider's client still takes the gateway's brokered servers", () => {
    const clients = createAllClients(createTestLogger(), {
      providerOverrides: {
        "claude-personal": { extends: "claude", label: "Claude Personal" },
      },
    });

    expect(clients["claude-personal"]?.provider).toBe("claude-personal");
    expect(clients["claude-personal"]?.acceptsMcpGatewayServers).toBe(true);
    expect(clients.claude?.acceptsMcpGatewayServers).toBe(true);
    expect(clients.codex?.acceptsMcpGatewayServers).toBeUndefined();
  });

  test("a derived claude provider adopts from its own account's config dir, not the base provider's", () => {
    const leaderDir = createAccountDir("leader", {
      amplitude: { type: "http", url: "https://amplitude.example/leader" },
    });
    const backupDir = createAccountDir("backup", {
      amplitude: { type: "http", url: "https://amplitude.example/backup" },
    });

    const clients = createAllClients(createTestLogger(), {
      providerOverrides: {
        claude: { env: { CLAUDE_CONFIG_DIR: leaderDir } },
        "claude-backup": {
          extends: "claude",
          label: "Claude Backup",
          env: { CLAUDE_CONFIG_DIR: backupDir },
        },
      },
    });

    const scope = clients["claude-backup"]?.resolveMcpConfigScope?.("/workspace");
    expect(scope?.configDir).toBe(backupDir);
    expect(clients.claude?.resolveMcpConfigScope?.("/workspace")?.configDir).toBe(leaderDir);

    // What adopt actually reads: the definition must come from the backup account's file.
    expect(
      findPerDirMcpServer({
        configDir: scope?.configDir ?? "",
        projectDir: "/workspace",
        name: "amplitude",
      }),
    ).toEqual({
      kind: "remote",
      server: { url: "https://amplitude.example/backup", transport: "http" },
    });
  });

  test("a derived provider's config dir expands ${VAR} against the env its sessions run with", () => {
    const accountsHome = mkdtempSync(join(tmpdir(), "paseo-claude-accounts-"));
    tempDirs.push(accountsHome);
    const personalDir = join(accountsHome, ".claude-personal");
    mkdirSync(personalDir);
    writeFileSync(
      join(personalDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { aspire: { type: "sse", url: "https://aspire.example/mcp" } },
      }),
    );
    process.env.PASEO_TEST_ACCOUNTS_HOME = accountsHome;

    const clients = createAllClients(createTestLogger(), {
      providerOverrides: {
        "claude-personal": {
          extends: "claude",
          label: "Claude Personal",
          env: { CLAUDE_CONFIG_DIR: "${PASEO_TEST_ACCOUNTS_HOME}/.claude-personal" },
        },
      },
    });

    const scope = clients["claude-personal"]?.resolveMcpConfigScope?.("/workspace");
    expect(scope?.configDir).toBe(personalDir);
    expect(
      findPerDirMcpServer({
        configDir: scope?.configDir ?? "",
        projectDir: "/workspace",
        name: "aspire",
      }),
    ).toEqual({ kind: "remote", server: { url: "https://aspire.example/mcp", transport: "sse" } });
  });

  test("a derived claude provider answers for its own account's sign-in state", async () => {
    const signedIn = createAccountDir("signed-in", {});
    writeFileSync(
      join(signedIn, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "worker@example.com" } }),
    );
    const signedOut = createAccountDir("signed-out", {});

    const clients = createAllClients(createTestLogger(), {
      providerOverrides: {
        claude: { env: { CLAUDE_CONFIG_DIR: signedIn } },
        "claude-personal": {
          extends: "claude",
          label: "Claude Personal",
          env: { CLAUDE_CONFIG_DIR: signedOut },
        },
      },
    });

    expect(await clients.claude?.describeAccountAuth?.()).toEqual({
      state: "signed-in",
      accountLabel: "worker@example.com",
    });
    expect(await clients["claude-personal"]?.describeAccountAuth?.()).toEqual({
      state: "signed-out",
      signInCommand: `CLAUDE_CONFIG_DIR=${signedOut} claude /login`,
    });
  });
});
