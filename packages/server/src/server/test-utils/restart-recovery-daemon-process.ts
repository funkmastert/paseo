import { createTestPaseoDaemon } from "./paseo-daemon.js";

// A test daemon in its own process, so a chaos test can SIGKILL it mid-turn and start another on
// the same PASEO_HOME. Env: RESTART_RECOVERY_HOME_ROOT (reused across processes) and
// RESTART_RECOVERY_MODE. SIGTERM is a clean shutdown.
async function main(): Promise<void> {
  const paseoHomeRoot = process.env.RESTART_RECOVERY_HOME_ROOT;
  if (!paseoHomeRoot) throw new Error("RESTART_RECOVERY_HOME_ROOT is not set");
  const mode = process.env.RESTART_RECOVERY_MODE as "off" | "plan" | "resume" | undefined;
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
    restartRecovery: mode ? { mode } : undefined,
  });
  process.send?.({ type: "ready", port: daemon.port, paseoHome: daemon.paseoHome });
  process.once("SIGTERM", () => {
    void daemon.close().then(() => process.exit(0));
  });
}

void main().catch((error) => {
  process.send?.({
    type: "error",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
});
