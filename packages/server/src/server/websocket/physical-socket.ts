// OOM backstop for a socket whose client stopped draining. A daemon normally has
// 1-10 physical sockets (tens at the outside), so 64 MiB bounds abandoned queues
// without treating ordinary large frames as a protocol or frame-size violation.
export const MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024;
// Current clients ping every 10 seconds. Four delayed cycles fit inside the
// lease without making an abandoned application socket linger for minutes.
export const APPLICATION_SOCKET_LEASE_MS = 45_000;
export const APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS = 10_000;
// A sweep this late means the daemon itself was not running (macOS suspends the
// app, including through dark wakes), so peers had no chance to be heard. Their
// pings are still queued behind this timer; expiring them here evicted every
// socket after each suspension.
export const APPLICATION_SOCKET_LEASE_STALL_MS = APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS * 2;

type Clock = () => number;

interface ApplicationSocketLeaseOptions {
  leaseMs?: number;
  stallMs?: number;
}

export class ApplicationSocketLease<TSocket extends object> {
  private readonly deadlines = new Map<TSocket, number>();
  private readonly leaseMs: number;
  private readonly stallMs: number;
  private lastSweepAt: number | null = null;

  constructor(
    private readonly clock: Clock = Date.now,
    options: ApplicationSocketLeaseOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? APPLICATION_SOCKET_LEASE_MS;
    this.stallMs = options.stallMs ?? APPLICATION_SOCKET_LEASE_STALL_MS;
  }

  claim(socket: TSocket): void {
    this.deadlines.set(socket, this.clock() + this.leaseMs);
  }

  renew(socket: TSocket): void {
    if (this.deadlines.has(socket)) {
      this.claim(socket);
    }
  }

  release(socket: TSocket): void {
    this.deadlines.delete(socket);
  }

  listExpired(): TSocket[] {
    const now = this.clock();
    const previousSweepAt = this.lastSweepAt;
    this.lastSweepAt = now;
    if (previousSweepAt !== null && now - previousSweepAt > this.stallMs) {
      for (const socket of this.deadlines.keys()) {
        this.deadlines.set(socket, now + this.leaseMs);
      }
      return [];
    }
    const expired: TSocket[] = [];
    for (const [socket, deadline] of this.deadlines) {
      if (deadline > now) continue;
      expired.push(socket);
    }
    return expired;
  }

  clear(): void {
    this.deadlines.clear();
  }
}

export function outboundFrameByteLength(data: string | Uint8Array | ArrayBuffer): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

interface BoundedPhysicalSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
}

export async function sendBoundedPhysicalFrameAndWait(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
}): Promise<boolean> {
  const { socket, frame, frameBytes = outboundFrameByteLength(frame), onHighWater } = params;
  if (socket.readyState !== 1) return false;
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    onHighWater();
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    let callbackUsed = false;
    const result = socket.send(frame, (error) => {
      callbackUsed = true;
      if (error) reject(error);
      else resolve();
    });
    if (result && typeof result.then === "function") {
      result.then(resolve, reject);
    } else if (socket.send.length < 2 && !callbackUsed) {
      resolve();
    }
  });
  return true;
}

export function physicalSocketHasCapacity(
  socket: Pick<BoundedPhysicalSocket, "bufferedAmount">,
  frameBytes: number,
): boolean {
  if (typeof socket.bufferedAmount !== "number") return true;
  return socket.bufferedAmount + frameBytes <= MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
}

export function sendBoundedPhysicalFrame(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
}): boolean {
  const { socket, frame, frameBytes = outboundFrameByteLength(frame), onHighWater } = params;
  if (socket.readyState !== 1) return false;
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    onHighWater();
    return false;
  }
  const result = socket.send(frame);
  if (result && typeof result.then === "function") {
    void result.catch(() => undefined);
  }
  return true;
}
