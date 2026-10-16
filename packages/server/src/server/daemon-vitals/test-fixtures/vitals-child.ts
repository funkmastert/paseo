// A real process running the real monitor, so a test can suspend it with SIGSTOP or block its
// main thread and watch what the monitor concludes. Driven over IPC; not part of the daemon.
import { EventLoopMonitor } from "../event-loop.js";

const paseoHome = process.argv[2];
if (!paseoHome) throw new Error("vitals-child needs a paseo home argument");

function relay(level: string, obj: object, msg?: string): void {
  process.send?.({ type: "log", level, msg, ...obj });
}

const monitor = new EventLoopMonitor({
  paseoHome,
  dryRun: true,
  thresholds: { tickMs: 50, slowStallMs: 300, wedgeMs: 1_000, suspendMs: 1_000 },
  heartbeatMs: 100,
  logger: {
    info: (obj, msg) => relay("info", obj, msg),
    warn: (obj, msg) => relay("warn", obj, msg),
  },
  onWedgeRecovered: (episode) => process.send?.({ type: "wedge-recovered", episode }),
});

function blockBusy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Spin: a wedge that burns a core.
  }
}

function blockWaiting(ms: number): void {
  // A synchronous wait that burns no CPU: what a thread parked in execFileSync looks like.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

process.on("message", (message: { type: string; ms?: number }) => {
  if (message.type === "busy") blockBusy(message.ms ?? 0);
  else if (message.type === "wait") blockWaiting(message.ms ?? 0);
  else if (message.type === "snapshot")
    process.send?.({ type: "snapshot", snapshot: monitor.snapshot() });
  else if (message.type === "stop") void monitor.stop().then(() => process.exit(0));
});

monitor.start();
// Keeps the process alive: the monitor's own timers are unref'd on purpose.
setInterval(() => undefined, 1_000);
process.send?.({ type: "ready", pid: process.pid });
