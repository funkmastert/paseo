import { expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";
import {
  APPLICATION_SOCKET_LEASE_MS,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
} from "./websocket/physical-socket.js";

const LARGE_REQUEST_BYTES = 512 * 1024;
// The paused socket's loopback kernel buffers (up to 4 MiB each way on macOS)
// fill before the daemon's own queue starts to count toward the cap.
const KERNEL_BUFFER_HEADROOM_BYTES = 16 * 1024 * 1024;
// Derived from the cap so raising it cannot leave the burst below it again.
const BURST_MESSAGE_COUNT = Math.ceil(
  (MAX_PHYSICAL_SOCKET_BUFFERED_BYTES + KERNEL_BUFFER_HEADROOM_BYTES) / LARGE_REQUEST_BYTES,
);
// The replacement reads each batch before the next is sent, so only the paused
// socket can reach the cap.
const BATCH_MESSAGE_COUNT = 8;
// Shorter than the application lease, so only the high-water bound can close
// the stale socket inside the test.
const TEST_TIMEOUT_MS = 30_000;

interface SocketClose {
  code: number;
  reason: string;
}

class ResumedPhysicalSocketSession {
  private replacement: WebSocket | null = null;

  private constructor(
    private readonly daemon: TestPaseoDaemon,
    private readonly original: WebSocket,
  ) {}

  static async launch(): Promise<ResumedPhysicalSocketSession> {
    const daemon = await createTestPaseoDaemon();
    const original = await connectSocket(daemon.port, "stale-physical-socket");
    return new ResumedPhysicalSocketSession(daemon, original);
  }

  async abandonOriginal(): Promise<void> {
    this.original.pause();
  }

  async resumeSameClient(): Promise<void> {
    this.replacement = await connectSocket(this.daemon.port, "stale-physical-socket");
  }

  async broadcastUntilOriginalCloses(): Promise<SocketClose> {
    const replacement = this.requireReplacement();
    const originalClose = waitForClose(this.original);

    for (let start = 0; start < BURST_MESSAGE_COUNT; start += BATCH_MESSAGE_COUNT) {
      const end = Math.min(start + BATCH_MESSAGE_COUNT, BURST_MESSAGE_COUNT);
      const lastRequestId = largeRequestId(end - 1);
      const batchResponse = waitForMessage(replacement, (message) => {
        return (
          message.type === "session" &&
          message.message.type === "pong" &&
          message.message.payload.requestId === lastRequestId
        );
      });

      for (let index = start; index < end; index += 1) {
        replacement.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "ping",
              requestId: largeRequestId(index),
              clientSentAt: index,
            },
          }),
        );
      }

      await batchResponse;
    }

    this.original.resume();
    return originalClose;
  }

  async replacementRoundTrip(): Promise<void> {
    const replacement = this.requireReplacement();
    const requestId = "replacement-still-active";
    await sendAndWait(
      replacement,
      {
        type: "session",
        message: { type: "ping", requestId, clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === requestId,
    );
  }

  async close(): Promise<void> {
    this.original.terminate();
    this.replacement?.terminate();
    await this.daemon.close();
  }

  private requireReplacement(): WebSocket {
    if (!this.replacement) throw new Error("Replacement socket is not connected");
    return this.replacement;
  }
}

test(
  "a resumed stale socket is bounded and removed without disrupting its replacement",
  async () => {
    expect(TEST_TIMEOUT_MS).toBeLessThan(APPLICATION_SOCKET_LEASE_MS);
    const session = await ResumedPhysicalSocketSession.launch();
    try {
      await session.abandonOriginal();
      await session.resumeSameClient();

      const originalClose = await session.broadcastUntilOriginalCloses();

      expect(originalClose).toEqual({ code: 1006, reason: "" });
      await session.replacementRoundTrip();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(port: number, clientId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(socket);
  await sendAndWait(
    socket,
    {
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
    },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  await sendAndWait(socket, { type: "ping" }, (message) => message.type === "pong");
  return socket;
}

function largeRequestId(index: number): string {
  return `${index}:`.padEnd(LARGE_REQUEST_BYTES, "x");
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = waitForMessage(socket, matches);
  socket.send(JSON.stringify(message));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<SocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for WebSocket to close"));
    }, TEST_TIMEOUT_MS);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
