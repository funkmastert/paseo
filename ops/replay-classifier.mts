// Throwaway: replays the classifier over real agent records. Read-only on ~/.paseo.
// usage: tsx replay-classifier.ts <pluginDir> <policy: live|fixed>
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [pluginDir, variant] = process.argv.slice(2);
const { classifyAgent } = await import(join(pluginDir, "server/classifier.ts"));
const { RoleModelPolicySchema } = await import(join(pluginDir, "shared/role-policy-schema.ts"));

const config = JSON.parse(readFileSync(join(homedir(), ".paseo/config.json"), "utf8"));
let rawPolicy = JSON.parse(JSON.stringify(config.agentModelPolicy));
// The live config was fixed by the orchestrator (dated -> undated). "live" replays the OLD spelling.
const DATED = "claude-haiku-4-5-20251001";
const swap = (list: string[]) => list.map((m) => (m === "claude-haiku-4-5" ? DATED : m));
if (variant === "dated") {
  for (const r of rawPolicy.roles) {
    r.models = swap(r.models);
    r.mechanicalModels = swap(r.mechanicalModels);
    r.hardModels = swap(r.hardModels);
  }
}
const policy = (RoleModelPolicySchema as any).parse(rawPolicy);

const models = JSON.parse(readFileSync(join(homedir(), "bozeo-ops/live-claude-models.json"), "utf8"));
const catalog = new Map([["claude", new Set<string>(models.map((m: any) => m.id))]]);
const thinkingCatalog = new Map([
  ["claude", new Map(models.map((m: any) => [m.id, { optionIds: m.thinkingOptionIds ?? [], ...(m.defaultThinkingOptionId ? { defaultOptionId: m.defaultThinkingOptionId } : {}) }]))],
]);
const health = { isHealthyFor: () => true, isHealthyForAllWindows: () => true, isLastResortEligible: () => true, windowUtilization: () => undefined, describeWindow: () => undefined, windowIds: () => [] };
const world: any = { policy, catalog, thinkingCatalog, pool: { workers: [{ providerId: "claude-personal", priority: 1 }], leader: { providerId: "claude" } }, health };

const root = join(homedir(), ".paseo/agents");
const tally = { total: 0, children: 0, byClass: {} as Record<string, number>, byClassSource: {} as Record<string, number>, byModel: {} as Record<string, number>, byRole: {} as Record<string, number>, mechanicalByModel: {} as Record<string, number>, unadvertisedEntries: {} as Record<string, number>, resolved: 0 };
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
for (const dir of readdirSync(root)) {
  for (const f of readdirSync(join(root, dir))) {
    if (!f.endsWith(".json")) continue;
    let d: any;
    try { d = JSON.parse(readFileSync(join(root, dir, f), "utf8")); } catch { continue; }
    if (!String(d.config?.model ?? d.provider).length) continue;
    const labels = d.labels ?? {};
    const hasCaller = labels["paseo.parent-agent-id"] !== undefined;
    tally.total++;
    if (!hasCaller) continue; // roots are always the leader; only children are routed by class/model pool
    tally.children++;
    const dec = classifyAgent({ labels, title: d.title, callerAgentId: labels["paseo.parent-agent-id"], requestedProvider: "claude" }, world);
    bump(tally.byClass, dec.taskClass.taskClass ?? "none");
    bump(tally.byClassSource, dec.taskClass.source);
    bump(tally.byModel, dec.model.model ?? "(request's own)");
    bump(tally.byRole, dec.role.role.id);
    if (dec.taskClass.taskClass === "mechanical") bump(tally.mechanicalByModel, `${dec.model.model} (${dec.model.outcome})`);
    for (const e of dec.model.unadvertisedPoolEntries) bump(tally.unadvertisedEntries, e);
    if (dec.model.resolvedFrom) tally.resolved++;
  }
}
console.log(JSON.stringify({ pluginDir: pluginDir.split("/").slice(-3).join("/"), variant, ...tally }, null, 1));
