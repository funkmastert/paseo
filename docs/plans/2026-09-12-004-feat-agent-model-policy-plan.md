# Agent Model Policy: roles, ordered model fallbacks, and settings UI

Status: design complete, ready for phased implementation (Phase 1 = engine, Phase 2 = settings UI, Phase 3 = deferred SDK gap).
Provenance: read-only design agent (Sonnet 5) on 2026-09-11; inputs = two PiSesh screenshots + the uploaded spec `role-model-policy-how-it-works.md`; evidence-checked against this tree at `437e0cde5` and the plugin repo at `~/paseo-plugins/claude-account-pool`.

---

## 0. What this adapts from, and why the mapping isn't 1:1

PiSesh's mental model is the semantic backbone — roles are named ordered model lists, resolution has a 3-tier precedence plus default, availability is catalog-intersection-preserving-order, unconfigured ≠ unavailable. But two load-bearing facts in this codebase make a literal port wrong:

1. **Paseo already has an account-pool plugin that owns `before('agent.create')` for Claude routing** (`~/paseo-plugins/claude-account-pool/index.server.ts:75-78`, `server/router.ts`). It rewrites `config.provider` (which Claude _account_ to run on) based on per-window health (`server/health.ts`). Role Policy needs to rewrite `config.model` (and, when crossing provider families, `config.provider`) based on role preference. These are two different axes of the same request, decided by two different signals, and they must compose in one deterministic order or a role's "preferred model" and the pool's "healthy account" can fight each other.
2. **Paseo has no plugin-contributed MCP-tool surface and no hook that can inject text into an agent's running prompt.** `docs/plugins.md` enumerates every contribution point — there is no "add an MCP tool" or "before agent turn, mutate the prompt" hook. `PluginBeforeRequests` (`packages/plugin/src/server/lifecycle.ts:67-77`) has exactly three hookable requests: `agent.create`, `agent.session_open` (env only), `workspace.create`. So PiSesh's "guidance" mechanism (`before_agent_start` prompt guidance, `worker_model_policy` agent-callable diagnostic) **cannot be built today** without a new SDK capability. See §4.

Two tiers of payoff:

- **Tier A — enforced today:** role → model routing for agents _Paseo itself creates_ (`create_agent` MCP tool, `paseo run`), enforced inside the existing plugin's `before('agent.create')`.
- **Tier B — recorded but not enforced today:** `ce-*` Claude Code Task-tool persona names. These run in-process inside the parent CLI on the parent's account (`docs/agent-lifecycle.md:175-187`, `packages/server/src/server/agent/providers/claude/subagents/live-source.ts:38-67`) — they never call `agent.create`, so no hook can see them. The mapping UI still accepts and stores these names, but v1's _effect_ for them is visible, exportable config — not automatic routing. §4/§7 Phase 3 covers the SDK addition that would close this.

## 1. Current-state evidence

### 1.1 The account-pool plugin (routing precedent to extend, not replace)

- `index.server.ts:75-78` — the only `before('agent.create')` registration today; `router.ts` rewrites `config.provider` only, never `config.model`.
- `server/router.ts:98-101,138-153,160-185` — `AgentCreateRouter`; gate = `callerAgentId` present AND `isClaudeFamily`. Selection ladder: healthy-for-model → last-resort-eligible → leader (with `PoolDryEpisode`).
- `server/health.ts:47-68,227-254` — `HealthTracker`: `isHealthyFor(providerId, modelId)`, `isLastResortEligible`, `isHealthyForAllWindows`; per-(account, window) healthy → drained → capped → probation.
- `server/windows.ts:11-51` — windows: `five_hour`, `weekly`, `account`, `weekly_model_<family>`; `modelWindowFor(modelId)`.
- `shared/pool-config.ts` — `params.accountPool = { role, priority }`; `resolvePool()`; config read via `paseo.config.get()` (`server/pool.ts:31-64`), 60s cache + on-demand refresh.
- `docs/plans/2026-09-10-001-...-plan.md` KTD1–KTD8 — fork discipline: policy in the plugin; fork carries only small additive hook-visibility patches.

### 1.2 Hook composition — role-hook and pool-hook can share one plugin

`packages/server/src/server/plugins/lifecycle/index.ts:177-250` — `before` handlers for one event are invoked **sequentially in registration order**, each output feeding the next input. Registering the role handler before the router handler in one `contribute()` gives deterministic composition — no cross-plugin ordering risk.

### 1.3 What the hook can and cannot see today

- `PluginBeforeRequests["agent.create"]` exposes only `{ config, env?, callerAgentId? }` (`packages/plugin/src/server/lifecycle.ts:67-74`); `beforeSchemas` pick at `packages/server/src/server/plugins/lifecycle/index.ts:30-35`.
- `labels` (`messages.ts:1703`, `default({})`) and `initialPrompt` (`messages.ts:1695`) are **already on the wire schema** — widening the pick + plugin types is zero wire-schema change (same shape as the U1 callerAgentId patch).
- `describeHookAgent` (`lifecycle/index.ts:78-94`) also drops `labels` today; widening it once fixes `agent.created` visibility too (needed for recently-seen-names autofill).
- `title` is visible today but is the WRONG stable key: as of `e0542f843` titles are actively rewritten post-creation by the title tracker — titles drift by design. `labels` are the documented categorization metadata (`agent-manager.ts:428-430`) and settable via both spawn paths today: MCP `create_agent` `labels` (`paseo-tools.ts:991`) and `paseo run --label k=v` (`packages/cli/src/commands/agent/run.ts:72-73,441-482`).
- Label-key convention precedent: `packages/protocol/src/agent-labels.ts` (`PARENT_AGENT_ID_LABEL`).

### 1.4 Model catalog available to plugin code

`PaseoApi.providers` (`packages/client/src/index.ts:557-574`): `listModels(provider, options)`, `snapshot`, `listUsage`, `refresh`. `docs/plugins.md:313-317` documents the `force` refresh convention — "Refresh Models" = `listModels(family, { force: true })`.

### 1.5 Settings storage: two mechanisms, only one fits the hot path

- `defineSettings`/`registerSettings`/`useSettings()` (docs/plugins.md:456-467; public-docs/plugins/v0.8/reference.md:979-1084) gives draft/save/revision-conflict semantics — but `registerSettings` returns no in-process read handle; the read/write path is RPC-shaped for the client hook, unusable from a hot `before('agent.create')` handler.
- The plugin's own precedent: store config in daemon config (passthrough), read via `paseo.config.get()` with an interval cache (`pool.ts:66-112`). `MutableDaemonConfigPatchSchema` is `.passthrough()` top-level (`messages.ts:258-277`).
- **Decision:** authoritative storage = new top-level daemon-config passthrough key `agentModelPolicy`; the settings screen gets draft/save/conflict ergonomics via hand-rolled plugin RPCs over `paseo.config.get/patch`. One source of truth — avoids the "policy saved but runtime resolves stale" failure PiSesh's own troubleshooting table warns about.

### 1.6 Forms/UI conventions

`docs/forms.md:16-56` plain-TS form model (drafts for names/aliases with Save/Cancel; immediate commands for model list/mapping mutations — matches PiSesh §9). Plugin-side settings components from `@getpaseo/plugin/client/ui` (`SettingsSection/Card/Row/Switch/Select/Input/Action`). Reordering = up/down arrow buttons per row (no drag primitive exists; arrows work on touch + desktop).

### 1.7 Protocol/RPC

No core RPCs added — plugin RPCs via `defineRpc`/`server.handle` only. The only wire-adjacent change is hook-visibility widening of already-sent fields; no COMPAT tag needed.

## 2. Resolved design decisions

### 2.1 Where the policy lives — extend `claude-account-pool`, not core, not a sibling plugin

Hook ordering is only trivially guaranteed inside one plugin (§1.2); model eligibility must consult the same in-memory `HealthTracker` the router uses; matches KTD1 fork discipline. Rejected: core `agents.modelPolicy` (duplicates plugin machinery in core, inconsistent with the account-pool being a plugin).

### 2.2 Role identity, aliases, validation — adopt PiSesh verbatim

Standard `worker`/`reviewer`/`advisor`: fixed lowercase ids, non-renamable/non-deletable, aliases + models editable. Custom roles: stable lowercase UUID id. One case-insensitive namespace across names + aliases. Limits: 64 roles, 8 aliases/role, 32 models/role, 256 mappings; role word `^[A-Za-z][A-Za-z0-9]{0,31}$`; mapping key `^[A-Za-z0-9_.\-]{1,128}$`; model id `provider/model` ≤256 bytes, no whitespace/control/commas/wildcards; dupes rejected case-insensitively; in-use custom roles undeletable.

### 2.3 Resolution precedence + model selection (adapted for Paseo's signals)

**Role resolution** (Paseo-created agents only — `callerAgentId` present, same gate as the router):

```
1. Explicit exact-name mapping: labels["paseo.agent-type"] in agentTypeMappings,
   else config.title as exact-match fallback key
2. Caller-declared role: labels["paseo.agent-role"] matched case-insensitively
   vs every role name+alias. Unknown/malformed: DO NOT error the create —
   log + fall through to (3) + one deduplicated notification to the caller's
   root leader (existing Notifier episode machinery)
3. Automatic task classification (deterministic, no model call):
   lowercase(title + " " + initialPrompt);
   a. configured role names+aliases first (user vocabulary wins)
   b. seeds: /review|verify|audit|check/ → reviewer;
      /research|scout|explore|investigate|advis|oracle/ → advisor; else worker
4. Default: worker
```

Seed mappings on first install: `worker, scout, researcher, delegate → worker`; `reviewer → reviewer`; `oracle, advisor → advisor`.

Divergence from PiSesh (justified): their tier 3 is a validated caller-supplied `taskClass` word with actionable errors back to the caller; Paseo has no synchronous error channel into a live agent turn that doesn't block creation, so tier 3 is automatic classification and tier-2 misconfigurations use notify-don't-block.

**Model selection:**

```
role.models empty → UNCONFIGURED: pass request through unchanged (never borrow another pool)
for (provider, model) in role.models, in order:
  not in live catalog for provider → skip
  claude-family → skip unless SOME pool member (worker or leader) isHealthyFor(model)
                  or isLastResortEligible   [viable-anywhere check, looser than the
                  router's ladder — router runs second and picks the account]
  non-claude → catalog presence is the whole check
  → ELIGIBLE: config.model = model; config.provider = family if different.
    Hand off to the existing router unchanged.
nothing eligible → UNAVAILABLE: use role.models[0] anyway (stay inside the approved
  pool, deterministic) + one deduplicated "role unavailable" notification.
  "Routing problems must be recovered — not used to skip requested subagents."
```

Health participates as viable-anywhere: e.g. Opus capped on all workers but healthy on leader → still eligible; the router's tested pool-dry path lands it on the leader. Catalog-missing vs pool-capped stay distinguishable for future diagnostics.

### 2.4 Storage — daemon-config passthrough key

```jsonc
// $PASEO_HOME/config.json
"agentModelPolicy": {
  "schemaVersion": 1,
  "roles": [ { "id": "worker", "name": "Worker", "standard": true, "aliases": [], "models": [] }, ... ],
  "agentTypeMappings": { "worker": "worker", ..., "oracle": "advisor" },
  "revision": "opaque-cas-token"
}
```

`models` entries use **provider-family ids** (`claude`, `codex`, ...), never pool-worker entry ids — this is what makes the two hooks compose. `revision` = compare-and-swap token bumped on accepted writes. Load path mirrors `pool.ts`: `loadPolicy` + `createPolicyCache` (60s + forceRefresh). Missing key → `DEFAULT_POLICY` (all roles unconfigured = behaviorally no policy). Present-but-malformed → **fail closed**: keep last good in memory, hook passes through; editor locks with banner, never wipes.

### 2.5 Fork patches — two small hook-visibility widenings (U1-shaped, independent PRs)

**F1 — `labels` on hook surfaces:** add to `PluginHookAgent` (`lifecycle.ts:23-30`) + `PluginBeforeRequests["agent.create"]` (`:68-74`); widen the pick (`lifecycle/index.ts:30-35`) and `describeHookAgent` (`:78-94`). No platform immutability guard for labels (legitimately mutable by hooks); the role hook's must-not-strip behavior is covered by plugin unit tests. Tests: labels visible on MCP + CLI/session paths; `{}` default; `agent.created` labels match stored record.
**F2 — `initialPrompt` on `before('agent.create')` only:** types + pick; not in `describeHookAgent`. Tests: present when sent, absent otherwise, unchanged when untouched.

### 2.6 Model catalog cache

`server/model-catalog.ts` — `createModelCatalogCache(paseo, families)` over `providers.listModels`, `Map<family, Set<modelId>>`, 60s + `forceRefresh({force:true})`.

### 2.7 Settings UI surface

`client.addSettingsScreen({ id: "agent-model-policy", title: "Agent Model Policy", icon: "Route", Component })` — appears under Settings → Plugins → claude-account-pool. No app-side changes.

### 2.8 Enforcement vs guidance boundary — stated in the UI

Mappings for names that never appear on real `agent.create` requests (all in-process Task-tool personas) are stored + displayed, never consulted. One-line note under the disclosure: "Mappings apply to agents Paseo creates. In-process subagent personas (like Claude Code Task-tool types) aren't visible to this routing hook yet — see the roadmap note below."

### 2.9 Settings UX — PiSesh interaction rules

Names/aliases = drafts with Save/Cancel + stale-revision conflict rejection; model/mapping mutations = immediate; removing last model → unconfigured, not deleted; limit-disabled Add controls with inline reasons; in-use custom role delete disabled with reason; malformed policy locks the editor showing last-good, never wipes; comma-separated alias input with persistent format hint.

## 3. Module map (plugin repo unless noted)

- `shared/role-policy-schema.ts` — `ROLE_WORD_RE`, `EXACT_AGENT_NAME_RE`, `MODEL_REF_RE`, `STANDARD_ROLE_IDS`, `RoleRecordSchema`, `RoleModelPolicySchema` (superRefine: one namespace dupe check, ≤256 mappings, mapping values reference existing roles, exactly the 3 standard roles), `AGENT_TYPE_LABEL = "paseo.agent-type"`, `AGENT_ROLE_LABEL = "paseo.agent-role"`, `DEFAULT_POLICY` with seed mappings.
- `server/role-policy.ts` — `loadPolicy(paseo)` / `createPolicyCache(paseo)` mirroring `pool.ts` (fail-closed on malformed, DEFAULT on missing).
- `server/role-resolve.ts` — pure `resolveRole(policy, { labels, title, initialPrompt }) → { role, tier: 1|2|3|4, warning? }`.
- `server/role-availability.ts` — pure `selectModel(role, requested, catalog, pool, health) → { outcome: "unconfigured"|"selected"|"unavailable", provider?, model? }`.
- `server/model-catalog.ts` — per §2.6.
- `server/role-router.ts` — `createRoleRouter({ policyCache, catalogCache, poolCache, health, recentAgentTypes, onDeclaredRoleUnknown?, onRoleUnavailable? }): AgentCreateRouter`; registered in `index.server.ts` BEFORE the existing router.
- `server/recent-agent-types.ts` — ring buffer (~200) of distinct `labels[AGENT_TYPE_LABEL] ?? config.title` fed from the `agent.created` observer once F1 lands; exposed via RPC.
- `shared/role-policy-rpc.ts` — `roleModelPolicy.read`, `.write` ({revision, patch} → saved|conflict|invalid, + `warning` for saved-but-cache-reload-failed), `.listModels` ({families, force}), `.recentAgentTypes`, `.explain` ({agentType?, title?} → {roleId, tier, selected}) — powers an in-UI "test this name" affordance in place of Pi's `/worker-models`.
- `client/settings/` — `agent-model-policy-screen.tsx`, `use-role-model-policy.ts` (forms.md plain model: commands `renameRole`, `setAliases`, `addModel`, `moveModel`, `removeModel`, `addMapping`, `removeMapping`, `save(revision)`, `cancelDraft`), `role-card.tsx`, `role-card-metadata-editor.tsx`, `model-row.tsx`, `add-model-dropdown.tsx`, `add-role-button.tsx`, `agent-role-mappings-section.tsx`, `mapping-row.tsx` (autocomplete from recentAgentTypes), `refresh-models-button.tsx`, `limits-banner.tsx`.

## 4. The confirmed SDK gap (Phase 3, deferred)

No hook exists for "before system prompt assembly" or "before in-provider Task-tool subagent launch"; no `registerAgentTool` contribution. Closing it = new SDK surface (e.g. `before('agent.turn_started')` returning prepended guidance, or `server.registerAgentTool`) — core-repo work needing its own plan. Until then Tier B mappings are readable config a human/orchestrator can apply manually to `.claude/agents/*.md` frontmatter.

## 5. Test list

**Fork (F1, F2):** hook visibility on both create paths; defaults; `agent.created` parity; existing e2e unaffected.
**Schema:** round-trip; standard-role invariants; case-insensitive namespace dupes; per-role model dupes; all four limits with clear messages; malformed model ids; delete-in-use rejection.
**Policy cache:** missing → DEFAULT (not fail-closed); malformed → fail-closed keeping last good; forceRefresh sees external `config.patch`.
**role-resolve:** tier order wins correctly; title fallback key only when label absent; unknown tier-2 value → tier 3 + exactly one `onDeclaredRoleUnknown` per (caller-root, value); custom vocabulary beats seeds; seed regexes; no callerAgentId → untouched.
**role-availability:** unconfigured pass-through byte-identical; order-preserving selection; catalog-miss skip; capped-everywhere-but-leader still eligible (integration test asserting the ROUTER lands it via leader); all-unavailable → models[0] + one episode + re-arm on recovery; non-claude catalog-only.
**model-catalog:** interval + force + transient-failure keeps last known.
**role-router composition:** integration — role hook sets model, unmodified account router runs second and picks the account with zero role-awareness.
**RPCs:** read; stale-revision conflict; invalid patch untouched; semantic no-op doesn't bump revision; saved-with-reload-warning distinct outcome.
**Fork e2e** (`agent-model-policy-routing.local.e2e.test.ts`, same local-only pattern): mapped `ce-code-reviewer` label lands Reviewer's top model on a healthy worker; pool-wide cap advances to fallback; title-classification case; unconfigured byte-identical pass-through.

## 6. Phasing

**Phase 1 — engine, config-file usable, zero UI:** F1 + F2 (independent PRs) → plugin modules + wiring → verify via e2e + `paseo run --label paseo.agent-type=...` smoke.
**Phase 2 — settings UI:** RPC handlers → `client/settings/*` → UI tests (draft/save/conflict, limit lockouts, malformed lockout, autocomplete).
**Phase 3 — deferred:** the §4 SDK gap; `.explain` already covers the v1 diagnostic need; an `addSlashCommand` diagnostic is a cheap fast-follow.
