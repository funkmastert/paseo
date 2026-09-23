#!/usr/bin/env node
// The `agent_model_policy` MCP server, as the daemon spawns it.
//
// It contains no logic on purpose: stdin goes to the socket, the socket comes
// back to stdout. The MCP server itself lives in the plugin process
// (server/classifier-tool.ts), because the answer has to come from the same
// classifier the create hook uses, against the same live catalog, pool and
// health — a child that recomputed it would be a second implementation of the
// rules, which is the thing this plugin exists to not have.
//
// Same shape as the fork's own `packages/server/scripts/mcp-stdio-socket-bridge-cli.mjs`.
// Not imported from there: a plugin directory can be installed anywhere, and
// the daemon's internal script paths are not part of any plugin contract.

import { createConnection } from "node:net";

const socketPath = process.env.PASEO_CLASSIFIER_SOCKET;
if (!socketPath) {
  process.stderr.write("PASEO_CLASSIFIER_SOCKET is not set; the agent model policy is unreachable.\n");
  process.exit(1);
}

const socket = createConnection(socketPath);

socket.on("error", (error) => {
  process.stderr.write(`agent model policy bridge error: ${error.message}\n`);
  process.exitCode = 1;
  process.stdin.destroy();
});

socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("close", () => process.exit(process.exitCode ?? 0));
process.stdin.on("end", () => socket.end());
