// Move an agent to another provider once its turn ends. The daemon refuses to move an agent
// mid-turn, so a session cannot move itself; this waits for it instead.
// Usage: node move-when-idle.mjs <agentId> <providerId> [maxMinutes]
import { connectToDaemon } from "/Users/tylerthackray/paseo-worktrees/bozeo/packages/cli/dist/utils/client.js";
const [agentId, providerId, maxMinutes = "30"] = process.argv.slice(2);
const deadline = Date.now() + Number(maxMinutes) * 60_000;
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
while (Date.now() < deadline) {
  try {
    const c = await connectToDaemon({ host: "127.0.0.1:6767" });
    const a = (await c.fetchAgents({})).entries.map((e) => e.agent).find((x) => x.id === agentId);
    if (!a) { log(`agent ${agentId} not found`); process.exit(1); }
    if (a.provider === providerId) { log(`already on ${providerId}`); process.exit(0); }
    if (a.status !== "running") {
      await c.moveAgentToProvider(agentId, providerId);
      log(`moved ${agentId.slice(0, 8)} from ${a.provider} to ${providerId}`);
      process.exit(0);
    }
    await c.close();
  } catch (e) {
    log(`retrying: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
log("gave up: still mid-turn at the deadline");
process.exit(2);
