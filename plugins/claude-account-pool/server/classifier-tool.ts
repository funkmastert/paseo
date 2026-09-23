import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDecision } from "./decision-summary";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";

/**
 * The classifier, reachable by an agent BEFORE it spawns anything, as an MCP
 * tool named `agent_model_policy`.
 *
 * ## Why a socket and a shim
 *
 * `@getpaseo/plugin` has no "register an agent tool" surface — a plugin
 * contributes daemon RPCs and app UI. What it CAN do is rewrite
 * `config.mcpServers` on `before("agent.create")`, and the daemon honors that
 * end to end (the fork's own
 * `packages/server/src/server/plugins/agent-configuration.e2e.test.ts` proves
 * it). So a plugin contributes an agent tool by injecting an MCP server it
 * ships itself.
 *
 * The daemon spawns an MCP server as a child process, but the answer has to
 * come from the SAME classifier the create hook uses, against the same live
 * catalog, pool and health — a child recomputing it from config on disk would
 * be the second implementation this whole change exists to delete. So the MCP
 * server lives HERE, on a unix socket, and the spawned child is a byte pipe
 * with no logic in it.
 *
 * That split is the fork's own pattern for a daemon-hosted MCP server, not an
 * invention: see `packages/server/scripts/mcp-stdio-socket-bridge-cli.mjs`,
 * which does the identical thing for the daemon's built-in servers. Keeping
 * the protocol on this side also keeps it typed and unit-testable in
 * process, which a hand-written JS child would not be.
 *
 * ## Why the bridge is written out rather than shipped as a file
 *
 * A plugin cannot find its own files. The daemon compiles a plugin to one CJS
 * bundle and evaluates it with `globalThis.eval` (plugin-process.ts), so there
 * is no module URL, no `__dirname`, and `import.meta.url` is `undefined` —
 * `new URL("./mcp/bridge.mjs", import.meta.url)` throws `TypeError: Invalid
 * URL` while the bundle loads, which is exactly how this took the plugin down
 * in production. `initialize` carries `pluginId`, `bundle`, `appVersion` and
 * `settingsDirectory`, and nothing that locates the plugin on disk.
 *
 * So the bridge travels as a string in the bundle and is written into the same
 * private temp directory as the socket when the tool is switched on. Nothing
 * to resolve, nothing to get wrong, and the bridge can never be a stale copy
 * left by an older install.
 *
 * The socket lives in a private 0700 temp directory, carries no credentials,
 * and answers only this one question — it reveals the operator's routing
 * policy to agents already running on that operator's machine.
 */

/** Spoken if the client doesn't name a version. Echoing the client's own is preferred — see `handleMcpMessage`. */
const PROTOCOL_VERSION = "2025-06-18";

const TOOL = {
  name: "agent_model_policy",
  description:
    "Ask what an agent WOULD be configured as before you create it: which role it resolves to, which task class, which model and pooled account it would run on, and which tools it would keep. Deterministic — this is the same classifier the daemon applies at agent.create, not advice. Use it when you are about to spawn an agent and want to know whether your labels get you the model you think they do.",
  inputSchema: {
    type: "object",
    properties: {
      agentType: {
        type: "string",
        description: "The paseo.agent-type label you would set (matched against the operator's exact-name mappings).",
      },
      agentRole: {
        type: "string",
        description: "The paseo.agent-role label you would set. Declaring a role is what lets its tool profile apply.",
      },
      taskClass: {
        type: "string",
        description: "The paseo.task-class label you would set: mechanical, standard, or hard.",
      },
      title: { type: "string", description: "The agent's title, as the create would carry it." },
      prompt: { type: "string", description: "The initial prompt. Text classification reads the title AND this." },
      requestedModel: {
        type: "string",
        description: "A model you would ask for explicitly. The answer says whether policy honors or overrides it.",
      },
      requestedProvider: {
        type: "string",
        description: "The provider for requestedModel. Defaults to the Claude pool.",
      },
      root: {
        type: "boolean",
        description: "Ask about a root agent (one started by a human, the CLI or the app) rather than a subagent.",
      },
    },
    additionalProperties: false,
  },
} as const;

/** The tool's arguments. Unknown/blank values fall through exactly as they do at create time. */
export interface ClassifierToolQuery {
  agentType?: string;
  agentRole?: string;
  taskClass?: string;
  title?: string;
  prompt?: string;
  requestedModel?: string;
  requestedProvider?: string;
  /** True to ask about a ROOT agent (no calling agent), which resolves to `leader` structurally. */
  root?: boolean;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ClassifierToolServerOptions {
  /**
   * The world to classify against, read fresh per query so an answer reflects
   * the live caches rather than whatever they held when the socket opened.
   */
  world: () => ClassifierWorld;
  /** Overrides the socket path. Tests use this; production takes the default temp dir. */
  socketPath?: string;
}

export interface ClassifierToolServer {
  /** Absolute path of the listening socket — handed to the bridge as `PASEO_CLASSIFIER_SOCKET`. */
  socketPath: string;
  /** Absolute path of the bridge script the daemon spawns as the MCP server's `command` argument. */
  bridgePath: string;
  close(): void;
}

/**
 * The spawned child, in full. stdin goes to the socket, the socket comes back
 * to stdout; it parses nothing and decides nothing.
 *
 * Plain node with no dependencies, and no imports beyond `node:net`: the
 * daemon spawns it with bare `process.execPath` in a temp directory, where no
 * package resolution exists.
 *
 * Deliberately free of backslash escapes, backticks and `${}`: this source
 * lives inside a TypeScript template literal, where every one of those needs
 * doubling, and getting that wrong produces a file that is a syntax error at
 * spawn time rather than a compile error here. `console.error` supplies its
 * own newline, and concatenation avoids interpolation, so what is written
 * below is exactly what lands on disk.
 */
const BRIDGE_SOURCE = `#!/usr/bin/env node
// Written at runtime by the claude-account-pool plugin. Do not edit: this file
// is recreated whenever the classifier tool is switched on, and deleted with
// the plugin's temp directory on teardown.
import { createConnection } from "node:net";

const socketPath = process.env.PASEO_CLASSIFIER_SOCKET;
if (!socketPath) {
  console.error("PASEO_CLASSIFIER_SOCKET is not set; the agent model policy is unreachable.");
  process.exit(1);
}

const socket = createConnection(socketPath);

socket.on("error", (error) => {
  console.error("agent model policy bridge error: " + error.message);
  process.exitCode = 1;
  process.stdin.destroy();
});

socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("close", () => process.exit(process.exitCode ?? 0));
process.stdin.on("end", () => socket.end());
`;

/** Everything the query carries, as classifier input. */
export function queryToInput(query: ClassifierToolQuery): ClassifierInput {
  const labels: Record<string, string> = {};
  if (query.agentType) labels["paseo.agent-type"] = query.agentType;
  if (query.agentRole) labels["paseo.agent-role"] = query.agentRole;
  if (query.taskClass) labels["paseo.task-class"] = query.taskClass;
  return {
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    title: query.title,
    initialPrompt: query.prompt,
    // A caller asking "what would this be?" is asking about a CHILD it would
    // spawn, unless it says otherwise — so a synthetic caller id stands in.
    callerAgentId: query.root === true ? undefined : "(policy-query)",
    requestedProvider: query.requestedProvider,
    requestedModel: query.requestedModel,
  };
}

/**
 * One MCP message in, zero or one reply out. `undefined` means "no reply" —
 * a notification, or a frame too malformed to answer on.
 *
 * A classification that throws comes back as an `isError` tool result rather
 * than a protocol error: the caller asked an advisory question and should get
 * something it can act on, not a tool crash.
 */
export function handleMcpMessage(
  message: JsonRpcMessage,
  world: () => ClassifierWorld,
): Record<string, unknown> | undefined {
  const { id, method, params } = message;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });

  switch (method) {
    case "initialize":
      return result({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-agent-model-policy", version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool "${String(params?.name)}"` } };
      }
      try {
        const decision = classifyAgent(queryToInput((params.arguments ?? {}) as ClassifierToolQuery), world());
        return result({ content: [{ type: "text", text: describeDecision(decision) }] });
      } catch (error) {
        return result({
          content: [
            { type: "text", text: `Could not classify: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        });
      }
    }
    default:
      // Notifications carry no id and take no response; an unknown method
      // that DOES carry one is answered so the client isn't left waiting.
      if (id === undefined) {
        return undefined;
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method "${String(method)}"` } };
  }
}

/**
 * Opens the socket the MCP pipe connects to. Never throws on a client's bad
 * input: a malformed frame is dropped, not a dropped connection, because the
 * caller on the other end is a language model improvising JSON.
 */
export function startClassifierToolServer(options: ClassifierToolServerOptions): ClassifierToolServer {
  // 0700 by default, so the bridge and the socket are readable only by the
  // account the daemon runs as.
  const directory = mkdtempSync(join(tmpdir(), "paseo-classifier-"));
  const socketPath = options.socketPath ?? join(directory, "classifier.sock");
  const bridgePath = join(directory, "agent-model-policy.mjs");
  writeFileSync(bridgePath, BRIDGE_SOURCE, { mode: 0o700 });

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const reply = handleLine(line, options.world);
        if (reply) {
          socket.write(`${JSON.stringify(reply)}\n`);
        }
      }
    });
    // A pipe that dies mid-query is ordinary; it must never take the daemon with it.
    socket.on("error", () => socket.destroy());
  });
  server.on("error", (error) => {
    console.error("[claude-account-pool] classifier tool socket error; the agent tool is unavailable", error);
  });
  server.listen(socketPath);
  // Never the reason the plugin process stays alive.
  server.unref();

  return {
    socketPath,
    bridgePath,
    close() {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function handleLine(line: string, world: () => ClassifierWorld): Record<string, unknown> | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    return undefined; // No id to answer on; dropping it is all MCP allows.
  }
  return handleMcpMessage(message, world);
}
