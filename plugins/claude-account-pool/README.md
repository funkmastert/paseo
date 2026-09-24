# claude-account-pool

Routes agents across a pool of Claude accounts instead of a single provider
entry, so an agent that would otherwise fail on a rate limit or credential
problem can fall through to another account.

Two `before("agent.create")` hooks run in order:

1. The **role router** decides *which model* an agent runs, and *which tools
   it may use*, from the role policy.
2. The **account router** decides *which pooled account* runs it.

They never overlap: the role router never picks an account, and the account
router never picks a model.

See [Where a spawn lands](#where-a-spawn-lands) for how the account router
ranks accounts, and [Role policy](#role-policy) for the second half — model
pools, tool enforcement, the leader role, and the Fable budget gate.

## Operator setup

### 1. Configure one provider entry per Claude account

Each pooled account is its own `agents.providers.<id>` entry that extends the
built-in `claude` provider and points at that account's credentials via
`env.CLAUDE_CONFIG_DIR`, following the "Multiple profiles for the same
provider" pattern documented in Paseo's `docs/custom-providers.md`. Add
`params.accountPool` to mark each entry's role in the pool.

In `$PASEO_HOME/config.json`:

```json
{
  "agents": {
    "providers": {
      "claude-leader": {
        "extends": "claude",
        "label": "Claude (Leader)",
        "env": { "CLAUDE_CONFIG_DIR": "/home/paseo/.claude-accounts/leader" },
        "params": {
          "accountPool": { "role": "leader", "priority": 1 }
        }
      },
      "claude-worker-1": {
        "extends": "claude",
        "label": "Claude (Worker 1)",
        "env": { "CLAUDE_CONFIG_DIR": "/home/paseo/.claude-accounts/worker-1" },
        "params": {
          "accountPool": { "role": "worker", "priority": 1 }
        }
      },
      "claude-worker-2": {
        "extends": "claude",
        "label": "Claude (Worker 2)",
        "env": { "CLAUDE_CONFIG_DIR": "/home/paseo/.claude-accounts/worker-2" },
        "params": {
          "accountPool": { "role": "worker", "priority": 2 }
        }
      }
    }
  }
}
```

`role` is `"leader"` or `"worker"`. `priority` is a positive integer; it
breaks ties between workers with the same headroom (see [Where a spawn
lands](#where-a-spawn-lands) — it is no longer the primary order). There must
be exactly one `leader` entry — it is the last-resort target once no worker
can run the request, and the anchor for pool notifications. Worker priorities
must be unique. Malformed or missing `accountPool` config anywhere in
`agents.providers` makes this plugin fail open: it treats the pool as empty
and steps out of the way rather than blocking agent creation.

### 2. Apply the config change

`agents.providers` is one of the daemon's reloadable config paths, but it is
not picked up automatically when you edit `config.json` on disk — run
`paseo reload` after saving to apply the new entries without restarting the
daemon. A full daemon restart is not required.

### 3. Install the plugin

This plugin is vendored inside the Paseo fork at `plugins/claude-account-pool`
(see [docs/plugins.md](../../docs/plugins.md#vendor-a-first-party-plugin)).
Point the daemon at your checkout of that directory:

```bash
paseo plugin install /path/to/your/paseo-fork-checkout/plugins/claude-account-pool
paseo plugin ls
```

Plugins are unsandboxed, trusted code: this plugin's server code runs with
the daemon user's access on the daemon host.

## Where a spawn lands

Keeping children off the leader's account is the point of the pool, and it is
still the normal case. It is a **preference**, not a rule: when no worker can
run a request, the leader account serves everything rather than nothing
running at all. Running the whole fleet on one account is worse than
isolation and far better than an idle machine.

The ladder, for an agent-spawned claude-family child:

1. a worker that is **healthy** for the requested model;
2. a worker that is **drained but not capped**;
3. the **leader account**, if it can run anything — isolation is gone here;
4. nothing. The pool is exhausted and the create is **refused**.

Tiers 1 and 2 stay separate rather than merging into one ranking: a drained
account has less room than a healthy one by definition, and letting a score
put a nearly-capped account ahead of a healthy one would trade the pool's
purpose for a rounding difference.

### Headroom, not priority order

Within a tier, accounts are ranked by how much work they can still absorb.
Fixed priority is what left a barely-used backup account idle while the two
accounts ahead of it walked into their weekly caps: priority never changes,
so nothing ever moved load to where the budget was.

An account's score is its **tightest window**, because a window is a wall —
95% free on the session window buys nothing when the weekly window has 2%
left. Each window scores as what is free in it now, plus what its reset gives
back, discounted by how long you have to wait (`server/headroom.ts`). That
discount is what makes "20% left, resets in an hour" beat "30% left, resets
on Friday": the first is about to be a whole fresh window, the second is all
there is until the weekend. The horizon is a day — the span a placement
decision actually covers.

An account with no usage reading scores as empty, the same optimistic
convention the Fable gate uses. With no readings at all every candidate ties
and the tie-break is the configured `priority`, which is exactly the order
this plugin used before — so a daemon whose usage polls are failing places
the way it always did.

### Weekly exhaustion

A 5-hour window is back within the working day; a weekly window can be dead
until Friday. They used to share one fallback cap duration, so a weekly-
exhausted account with no reported reset time was handed back out five hours
later, to fail again.

They now age on their own clocks: 5 hours for the session window, 7 days for
a weekly one. This only applies when the daemon reports no `resets_at` for
the window — a real state, since those rows are nullish — because a known
reset time is always used in preference to either default.

### One account left

When the pool comes down to a single usable account, every leader spawning
into it is told **once**, not once per spawn. That state is the moment the
thing the pool exists for stops being true: from there a single cap takes
down every agent at once, and the fixes are all ones a person has to make —
sign another account in, raise a limit, or wind the fleet down.

Survivors are counted as **accounts, not entries**. Two provider entries
signed into one Claude login report identical usage windows because they *are*
the same windows, so counting them as two survivors is exactly how a collapse
stays quiet. The plugin cannot ask a provider who it is logged in as, so it
groups entries whose usage fingerprints match — percentages *and* reset
timestamps, across at least two windows (`server/account-identity.ts`). One
matching window is a coincidence worth having; two, down to the second, is
not.

Collapse is reversible on its own: an account recovering re-arms the notice
and new placements go back to preferring isolation. Agents already placed on
the shared account are the return leg's business, not this one's.

### No account left

Every account capped is the one case where a spawn is **refused** — the hook
throws, and the caller sees text naming every exhausted account and the
earliest known reset.

Passing the request through instead puts the child on a dead account where it
fails on its first turn, and a leader that reads that as "that one didn't
work, try another" spawns the next one straight into the same wall. One clear
error costs less than an unbounded loop. Refusal requires positive evidence —
every pool member actually capped — so an unreadable pool still fails open,
and a root agent is never refused (see below), so it can never lock you out of
your own daemon.

Set `refuseWhenExhausted: false` on `createRouter` to go back to passing
through. It is a code-level option, not daemon config: an unknown key in
`config.json` makes a running daemon reject the whole file.

### Root agents

A root agent (no `callerAgentId`: the app, the CLI, a schedule, a heartbeat)
keeps the account it was started on while that account can run it, worker
accounts included. It moves only when that account has a window **at its
cap** — `five_hour`, `weekly`, or the `weekly_model_*` window for the
requested model. A drained account is still the person's choice. With no
model named, any capped window counts. A root that asks for the bare `claude`
id is a pool-family request even when no pool entry is named `claude`, as it
is for a child, and is judged on that entry's own usage.

The app remembers the last provider a workspace used, so a new chat can ask
for an account that ran out since. Before this, it started there and died on
its first turn while the leader account had budget.

When it moves, it goes to the leader account first — a root is a leader by
definition — and then to a worker, ranked like a child's. The agent is
labelled `paseo.account-rerouted=<the account it asked for>`, the daemon log
carries the reason, and the settings preview (Test This Name, started by a
root agent, with the account filled in) shows the same sentence. When nothing in the pool can run it, it keeps its
account and starts anyway: a root is never refused. Nor can routing itself
fail one: any error while placing a root logs a warning and keeps the account
it asked for.

## Role policy

Stored under the top-level `agentModelPolicy` key in daemon config, edited
from the **Agent Model Policy** settings screen. A role is resolved for every
`agent.create`, and decides two things: which model the agent runs, and which
tools it may use. The model half is further split by **task class** — how much
model the work is worth — described below.

The policy model (roles, aliases, ordered model pools, explicit agent-type
mappings, and their precedence) is ported from
[pi-roles](https://github.com/wonderlydotcom/pi-roles); see its
`docs/roles-protocol.md`. What follows is only what differs or is new here.

### One classifier decides all of it

`classifyAgent` in `server/classifier.ts` is the single authority. It takes
everything known at `agent.create` — labels, title, initial prompt, whether
there is a calling agent and what that caller was itself denied, any requested
provider/model, the policy document, the live catalog, the pool and its health
— and returns one `AgentDecision`: role, task class, model, account, tool
profile, **and a sentence per part saying why**.

Everything that needs the answer calls that one function:

| Consumer | What it does with the decision |
| --- | --- |
| `before("agent.create")` (`server/role-router.ts`) | Writes it onto the request: `config.model`, `config.provider` on a cross-family selection, the tool profile into `config.providerOptions`, the labels recording what happened. |
| `role-model-policy.explain` (`server/role-policy-rpc-handlers.ts`) | Projects it onto the wire for the settings preview. |
| `agent_model_policy` (MCP tool, below) | Renders it as text for an agent asking before it spawns. |

The properties it holds to, each one bought with an incident:

- **Deterministic.** No clock, no randomness, no I/O, no model call. Everything
  time-dependent is an argument — including `nowMs`, the instant the account
  ladder scores headroom against — so a decision replays exactly from its
  inputs. An LLM classifier was evaluated and rejected: this runs on every
  create and may add neither latency nor cost.
- **Explicit beats inferred**, at every level.
- **Inference may choose a model; it may never remove capability.** A role
  guessed from text can pick the model. It cannot take Edit/Write/Bash away.
  See ["A guessed role may pick a model. It may not take tools away."](#a-guessed-role-may-pick-a-model-it-may-not-take-tools-away).
- **Nothing silent.** Every part carries its reason, and those reasons are
  what the explain RPC and the settings preview print — the rendering side
  states no rule of its own.

#### Keeping the prose from becoming a fifth authority

The rules used to be restated in English in two more places — the
`agent-orchestration` skill and the daemon's fleet-wide
`daemon.appendSystemPrompt` — and both drifted. The fix is not to keep them in
sync; it is for them to stop stating rules. They should name the **vocabulary**
and point here.

The paragraph a fleet prompt should carry, in full:

> **MODEL POLICY.** You do not choose models for Paseo agents — the
> account-pool classifier does, deterministically, on every `agent.create`. You
> choose LABELS. On `create_agent` set `paseo.task-class` to `mechanical` (rote,
> low-risk: a rename, a formatting pass, a version bump), `standard` (the
> default; omit it) or `hard` (concurrency, migrations, security, architecture,
> cross-cutting refactors), and set `paseo.agent-type` or `paseo.agent-role`
> whenever the agent's role matters — an unlabelled role is guessed from your
> prompt text, and a guessed role may pick a model but is never allowed to
> apply a restrictive tool profile, so the reviewer you meant to sandbox will
> not be sandboxed. Do not set `config.model` to force a better model: policy
> overrides a request the resolved pool doesn't approve, and labels the agent
> `paseo.model-overridden-by-policy` — asking for the right task class is the
> supported way to get a better model. **Opus 5.5 leads**: it heads the leader
> pool and every `hard` pool. **Fable is in no pool at all** — Opus 5.5
> supersedes it, so nothing routes there and asking for it gets you overridden.
> To see what a create would actually produce before you make it, call the
> `agent_model_policy` tool, which runs the same classifier the daemon does and
> reports the role, class, model, account and tools you would get, with the
> reason for each. The pools themselves are operator config, not prose to
> memorise — this paragraph names the vocabulary, the classifier holds the
> rules.

That is the whole contract. Anything longer is a copy of the code, and a copy
of the code is a thing that goes stale while still sounding authoritative.

One consequence worth naming, because it was the whole argument for doing
this: `decideModel` builds **one** options object and passes it to both the
explicit-request check and ordered selection. When `allowUnlistedModels`
arrived (below), wiring it in was a single line in a single place rather than
three call sites that could disagree about whether an id is selectable. The
facts it produces — `unadvertised`, `unadvertisedPoolEntries`,
`override.missingFromCatalog` — are fields on the decision, so the create
hook's log, the agent's label and the settings preview all say the same thing
without any of them re-deriving it.

The account half of the decision comes from `server/account-select.ts`, the
same ladder the account router walks. Extracting it is what lets a preview
answer "which account would this land on" without running the create hook.
The create hook itself deliberately supplies no `nowMs`: the account router
runs next and owns that decision, episodes and all.

### Model refs are account-agnostic by default

A role's model entries take one of two forms:

- `claude-sonnet-5` — **account-agnostic**. The role picks the model; the
  account router still picks which pooled account runs it. This is the form
  that survives one account being capped.
- `codex/gpt-5.1` — **pinned** to that provider. Use it to cross provider
  families.

Pinning to a claude-family provider id pins the *family*, not the account: the
account router runs after the role router and still has the final say on which
pooled account serves a claude-family request. The settings screen therefore
only ever writes the bare form for the pooled family.

#### Migration from schema v1

v1 wrote every ref as `provider/model`, and the only provider id it could name
for a pooled account was `claude` — which on a typical install is *also* the
pool leader's provider entry id. That ambiguity is what stranded every role
when the leader account died: read as an account, the whole policy was pinned
to one account.

Migration drops the provider segment from any ref naming the pool leader, or
naming the pool family itself. The second clause matters when the pool config
can't be read at all, where defaulting to "still pinned" would be the bug.
Cross-family pins (`codex/…`) are carried through untouched.

Migration happens **in memory on every read**; the parser never writes
settings, and the CAS `revision` is preserved so a settings screen opened
before the upgrade can still save. The migrated document only lands on disk
when you make some other change and save — which is also when the leader role
below is persisted.

### Task class: what the work is worth, not who does it

A role says what an agent **is**; it says nothing about what the work it was
handed is **worth**. The same `worker` gets a two-line rename and a
race-condition hunt, and with role alone both land on the same model — so
agents pick by habit, and the habit is "ask for the best model". A leader
requesting Opus for everything because nothing told it otherwise is what
burned an entire weekly account budget here.

A **task class** is the second, orthogonal dimension: the role picks WHO runs
the work, the task class picks HOW MUCH MODEL it's worth. Roles are still
where tool enforcement lives; classes touch model selection and nothing else.

Why orthogonal rather than replacing roles: they answer different questions
and are resolved from different evidence. A reviewer stays a reviewer whether
it's reviewing a typo fix or a migration, and it stays read-only either way —
folding the two into one axis would either multiply the role list by three or
make "read-only" depend on how hard the task sounded. It also keeps the
settings screen comprehensible: one card per role, three pools inside it,
instead of a role list that grows combinatorially.

#### The vocabulary is fixed, and deliberately small

| Class | For | Wrong answer costs |
| --- | --- | --- |
| `mechanical` | Rote, low-risk, narrowly scoped: a rename, a typo, a formatting pass, a changelog line, a version bump. | Cheap — obvious on sight, cheap to redo. |
| `standard` | Everyday work of ordinary, unestablished difficulty. **The default.** | The usual. |
| `hard` | Real correctness or design risk: concurrency, migrations, security, architecture, cross-cutting refactors. | Expensive — a subtly wrong answer found much later. |

Three levels, not five, and not operator-definable the way role names are. A
caller has to pick correctly without thinking hard, and a vocabulary nobody
applies consistently is worse than none: three levels are exactly enough to
separate "cheaper than usual", "the default", and "reach for the best model".

#### What a caller does differently

Set a `paseo.task-class` label on the create, alongside the
`paseo.agent-type` label the role ladder already reads:

```jsonc
{ "labels": { "paseo.agent-type": "worker", "paseo.task-class": "hard" } }
```

Matched case-insensitively against the three ids. **Nothing else changes for
an existing caller** — a create with no such label behaves exactly as it did
before the dimension existed.

Root agents included: unlike the role ladder, where a root agent is
deterministically the `leader` and isn't classified at all, task class is
resolved the same way for every create. A leader's own work has a difficulty
like anything else, and a leader asking for the best model for a two-line
change is the case that started all of this.

Resolution precedence mirrors `resolveRole`'s "declared beats guessed" shape,
with fewer tiers because there is no per-policy class vocabulary to configure:

1. **Declared** — `labels["paseo.task-class"]` naming one of the three ids.
   The cheapest and most trustworthy signal there is: the caller is stating
   what it's asking for rather than leaving it to be guessed.
2. **Unknown declared value** — never blocks. Falls through to classification
   with the value reported once per (caller, value) so the caller can be
   told, the same way an unknown `paseo.agent-role` is handled.
3. **Classified** — keyword seeds over the title + initial prompt (below).
4. **Default** — no class at all, which resolves to the role's standard pool.

#### Three pools per role

A role carries `models` (the standard pool, unchanged), plus optional
`mechanicalModels` and `hardModels` override pools. A class's pool is used
when it's non-empty; an empty one **falls back to `models`**. So a role that
never configures the new pools behaves exactly as it always did, and there is
no such thing as a class that strands a role with nothing to run.

`classModels(role, taskClass)` is the single function that makes that choice,
and both the router and the `explain` RPC go through it — there's one place
where "which pool" is decided, not two that can drift.

#### Cheap by default, and the expensive model is opt-in

An unclassified task resolves to **no class**, which means the standard pool:
the model you told the role to use for everyday work. The expensive entry is
reachable only from the `hard` pool, which means reaching it takes either an
explicit `paseo.task-class: hard` or a hard-seed keyword match — never the
mere *absence* of information.

That is the whole point of the default. The failure being designed against is
not "someone picked the wrong class", it's "nobody picked anything and the
spawn silently landed on Opus". Under this default, not deciding gets you the
everyday model; getting the expensive one requires saying so.

The corollary is an operator instruction, not a plugin behaviour: **put your
everyday model first in the Standard pool and keep the expensive one in the
Hard pool.** The plugin has no cost ranking for models and won't invent one —
it can't tell you your Standard pool starts with an expensive model, so that
part is on you.

#### How an unlabelled task is classified, and what it honestly costs

Deterministic keyword seeds over `lowercase(title + " " + initialPrompt)`.
No LLM call, no network, no tokens: a handful of regex tests on a string the
hook already has in hand, on a code path that runs once per `agent.create`.

An LLM classifier was rejected on its own arithmetic rather than on taste. It
would spend tokens on **every spawn** to save tokens on **some** of them, and
the saving is capped by how often a spawn would actually have been
misclassified into a more expensive pool — while the cost is paid
unconditionally, adds a network round trip to the create path (which the hook
cannot fail or stall), and makes the model an agent gets depend on a second
model's mood. For a feature whose justification is saving budget, a
per-spawn spend with an unmeasured hit rate is the wrong trade. If that
arithmetic ever gets measured and comes out the other way, the seam is
`classifyTaskClass` in `server/role-resolve.ts` and nothing else has to move.

What the seeds actually look for:

- `hard` — race condition, deadlock, concurrency, distributed, migration,
  security, vulnerability, architecture, redesign, cross-cutting, consensus,
  data loss, corruption.
- `mechanical` — typo, rename, formatting, whitespace, changelog, lint, dead
  code, unused import, one-liner, trivial, version bump.

`hard` is tested first on purpose: "fix the typo that's causing the race
condition" must not be under-classified by the word "typo".

Be honest about what this is: **a narrow filter, not a classifier.** It
recognizes the unambiguous cases and returns "no class" for everything else,
which is most real prompts. It can never move a task *to* `standard` — that
is already the default — so its only effect is to shift the clearly-cheap and
the clearly-risky off the everyday pool. If you want a class reliably, declare
it. The guess is a convenience for callers that haven't been taught the label
yet, not the mechanism.

#### A guess may pick a model. It may never remove a tool.

The same rule the role ladder follows, for the same reason. Task class feeds
**model selection only** — it is never consulted for tool-profile
enforcement, which stays role-based and evidence-gated on its own terms (see
[A guessed role may pick a model. It may not take tools away.](#a-guessed-role-may-pick-a-model-it-may-not-take-tools-away)).

This is not an oversight to be fixed later. A guessed role once stripped
`Edit`/`Write`/`Bash` from implementation agents and cost 1.1M tokens in a
single incident. A wrong model guess costs a little quality on one task; a
wrong capability guess breaks an agent mid-task, invisibly. Because task
class cannot gate tools at all, there is no `enforceToolsOnClassifiedRoles`
equivalent for it — no escape hatch, because there's nothing to escape.

#### Nothing about it is silent

- `role-model-policy.explain` accepts an optional `taskClass` (simulating
  the label) and returns `taskClass`, `taskClassSource`
  (`declared` | `classified` | `default`), and `unknownDeclaredTaskClass`
  when a declared value wasn't recognized. `requestedModelOverride` is
  evaluated against the **resolved class's** pool, not always the standard
  one — so "why was my Opus request overridden?" has a one-step answer.
- An unrecognized declared value never blocks, and is logged to the daemon
  log once per (caller, value) naming the three ids it expected.
- The "no eligible model" and "explicit model overridden" notifications
  dedupe per **(role, class)** rather than per role: a mechanical-pool
  exhaustion and a hard-pool exhaustion on the same role are different,
  actionable facts.
- An overridden explicit request still gets the
  `paseo.model-overridden-by-policy` label carrying the ref that was asked
  for, exactly as before — the class changes which pool decided, not whether
  you're told.

#### On the settings screen

**Agent Model Policy → Roles.** Each role card now shows three labeled model
pools instead of one — *Standard*, *Mechanical*, *Hard* — each with its own
add / reorder / remove controls, and each hinting at what it's for and that
an empty class pool falls back to Standard. Same compare-and-swap `revision`
flow as every other edit: the three pools are just three fields of the same
document, saved through the same validated write.

**Agent Model Policy → Test This Name.** The resolution preview runs the real
classifier over a hypothetical create and prints one line per part of the
decision: role, task class, model (with **which pool actually decided**,
including "that class's own pool is empty, so the standard pool decided"),
tools, account, and — when a model request was simulated — whether policy
honored or overrode it.

It takes the same inputs a create carries: agent type, title, **initial
prompt**, declared task class, an explicit model request, and whether the
agent would be started by another agent or by you. The prompt and the
root-agent switch are new, and they are not conveniences: the preview used to
classify from the title alone while the hook classified from title *and*
prompt, and a root agent — the one that resolves to `leader` — could not be
previewed at all. It also used to print the role's **configured** tool profile
even where the hook would have withheld it, so a guessed `reviewer` read as
read-only on screen while the real agent kept every tool. Both are gone: the
panel renders `reasons.*` from the classifier and states nothing itself.

#### Migration from schema v3

There is no data migration. `mechanicalModels` and `hardModels` default to
`[]` at the schema level, so every existing role's `models` pool round-trips
byte-identical and an empty class pool means "use the standard pool". The
version bump is the entire v3 → v4 step. As with every migration here it runs
**in memory on every read**, never writes settings on its own, and preserves
the CAS `revision` so a settings screen opened before the upgrade can still
save.

### An explicit model request wins, but only when it's currently selectable

A caller can ask for a specific model directly (`mcp__paseo__create_agent`'s
`provider` field as `provider/model`, or `config.model` on a session create).
The role router's precedence:

1. **The explicit request wins when it's a member of the pool the resolved
   (role, task class) selects AND currently selectable** — the same
   eligibility bar ordered selection holds every other candidate to: present
   in the live catalog, a viable pool member, and (for Fable) under the
   budget threshold. The
   request passes through untouched: model, provider, and account all stay
   exactly what was asked for.
2. **Policy wins otherwise**, whether the model was never approved for this
   role or was approved but isn't selectable right now. The role's own
   ordered selection runs as usual and the request is rewritten to it — but
   the override is never silent: it's logged with a reason-specific message,
   the created agent gets a `paseo.model-overridden-by-policy` label
   carrying the ref that was asked for, and the `role-model-policy.explain`
   RPC accepts optional `requestedModel`/`requestedProvider` fields so the
   settings screen can simulate the same decision
   (`requestedModelOverride: { requestedRef, honored, effectiveRef?,
   reason? }`).

The override reason distinguishes two different situations:

- `not-approved` — the requested ref was never one of the role's configured
  entries; the role forbids it outright.
- `not-currently-selectable` — the requested ref IS one of the role's
  configured entries, but isn't selectable right now (catalog-missing and
  not in `allowUnlistedModels`, no viable pool member, or gated by the Fable
  budget threshold). This is
  deliberately treated as an override rather than honored as-is: the
  failure this exists to prevent is an agent spawned onto an account/model
  with no budget left, dying on its first turn. A caller who asked for an
  approved model that's temporarily unavailable gets policy's live
  selection instead, with a message that says so — not the same message as
  a caller who asked for a model the role forbids.

#### Models the CLI accepts but doesn't advertise: `allowUnlistedModels`

The catalog check exists so nothing lands on a nonexistent model, but it
can't tell "absent because it isn't real" from "absent because the provider
doesn't advertise it". Claude Code 2.1.280 runs `claude-opus-5-5` yet omits
it from its model list, so without an escape neither a caller nor a pool
could ever reach it.

`agentModelPolicy.allowUnlistedModels` is an operator-set list of model refs
(same `model` / `provider/model` spelling as a pool). An id named there
counts as present for the catalog check, for an explicit request **and** for
ordered pool selection: an id the operator wrote down is operator-verified,
so it may be a pool default (put it first in a pool to make it the default).

```json
"agentModelPolicy": {
  "allowUnlistedModels": ["claude-opus-5-5"],
  "roles": [ { "id": "leader", "models": ["claude-opus-5-5", "claude-opus-5"], ... } ]
}
```

What stays exactly as it was:

- **Capped, drained, or budget-gated is still refused.** Only the catalog
  check is waived; pool viability and the Fable budget gate still apply.
- **A non-allowlisted unlisted pool entry is still skipped**, both by
  ordered selection and as an explicit request.
- **The role must still approve an explicit request.** The requested id has
  to be in the resolved (role, task class) pool; the allowlist adds no
  approval.
- **Per id, not a switch.** A typo (`claude-opus-5-6`) matches no entry, so
  as an explicit request it's refused at validation and overridden to the
  pool's default instead of dying at launch. That is why this is a list and
  not a boolean, and why the default is empty.

It is loud, not silent, on both routes:

- The daemon log gets an `UNVERIFIED MODEL` line (once per caller, role,
  class, ref, and route) saying the catalog doesn't list the model, whether
  a caller asked for it or the pool selected it, and which config let it
  through.
- The created agent carries `paseo.model-unadvertised=<ref>`. If an agent
  dies at launch, this label tells you the provider rejected an id nobody
  but the operator verified: remove it from the list.
- `role-model-policy.explain` reports `modelUnadvertised: true` when the pool
  default is unlisted, `requestedModelOverride.unadvertised: true` when an
  explicit request was honored on that basis, and `missingFromCatalog: true`
  on a refusal that adding the id to the list would lift (a capped model
  never carries it). `unadvertisedPoolEntries` names the pool entries
  ordered selection SKIPS (unlisted and not allowlisted). `explain` accepts
  an optional `role` (simulating `paseo.agent-role`) so the `leader` role,
  which no agent-type mapping reaches, can be queried.

Edits apply to the next spawn: the role hook re-reads `agentModelPolicy` on
every `agent.create`, and `explain` re-reads before answering, rather than
waiting for the 60-second cache tick. Before this, a create landing seconds
after a config edit was routed by the stale policy, and `explain` said the
edit had been ignored while `role-model-policy.read` (which never used the
cache) showed it.

"Member of the pool" means the requested `(provider, model)` matches, by
family, one of the entries in the pool `classModels(role, taskClass)` picked
— the class's own pool when it's configured, the standard pool otherwise. An
account-agnostic entry matches any pooled account's provider id, the same way
normal selection does. A role whose resolved pool is empty has nothing to
override, so every explicit request passes through untouched, matching the
"unconfigured" pass-through behaviour above.

This only applies when the daemon can actually tell a real request apart
from "nothing was asked for": `config.model` arrives at this hook as
`undefined` unless the caller set it (directly, or via `provider/model`
syntax), so its presence is the explicit-request signal — the same one the
account router already uses to decide whether a create asked for a specific
model.

### Tool profiles

pi-roles is explicit that role resolution is "guidance, not launch
enforcement", and gets enforcement by writing routes into the agent definition
files its host reads. Paseo has no such file. The equivalent here is
`config.providerOptions`, which this plugin's `before("agent.create")` hook
rewrites and a spawned agent cannot undo — `update_agent_request` accepts only
name and labels.

Enforcement is written in two layers: `disallowedTools`, which the Claude
Agent SDK removes "from the model's context" so they cannot be used at all,
and `settings.permissions.deny`, the `--settings` tier that outranks project
and user settings files.

| Profile | Denies |
| --- | --- |
| `unrestricted` | Nothing. The default, so upgrading changes no behaviour. |
| `orchestrator` | `Read`, `Glob`, `Grep`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, the Paseo terminal/workspace-script MCP tools below, `mcp__paseo__update_agent`, **every** `mcp__paseo__browser_*` tool, `Task`, `Agent` |
| `read-only` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, the Paseo terminal/workspace-script MCP tools below, the whole agent-lifecycle family (`mcp__paseo__update_agent`, `cancel_agent`, `archive_agent`, `kill_agent`, `set_agent_mode`, `respond_to_permission`, `send_agent_prompt` — `create_agent` stays), the page-interaction `mcp__paseo__browser_*` tools below |
| `write` | Nothing — file and shell tools are the point of this profile. |
| `custom` | Whatever you list. |

`read-only` denies `Bash` because a shell redirect writes files just as well
as `Write` does. A custom profile's *pre-approve* list only skips permission
prompts; it cannot re-enable a denied tool, since `disallowedTools` has
already removed it.

Restrictions only accumulate. Whatever the caller already denied stays denied
— a plugin that can silently widen a caller's own sandbox would be a worse bug
than an unenforced role.

#### A restriction is never silent

Enforcement alone produces the worst version of this feature: an agent that
finds out it has no `Edit` by reaching for `Edit`. That discovery burns a
whole turn, and what it usually does next is look for a way around the
denial. In the production incident that motivated this rework, one agent
spent **1.1M tokens** working out it had been disarmed and another **387k**
spawning helpers that turned out to be disarmed too.

So when a restrictive profile is applied, the hook also writes a short block
into `providerOptions.appendSystemPrompt` saying what is gone, that it is gone
for good rather than one permission prompt away, and what to do instead — a
`read-only` agent reports the change it would make, an `orchestrator`
delegates through `mcp__paseo__create_agent`.

This is a **system-level** note, not a prompt prefix. `appendSystemPrompt` is
a Paseo-owned key on `providerOptions` (not an SDK option — see the fork's
`providers/claude/options.ts`), destructured out before the rest of
`providerOptions` reaches the Claude Agent SDK and folded into the SDK's
single `systemPrompt.append` slot by `buildOptions()`
(`providers/claude/agent.ts`), composed in order: the agent's own
`systemPrompt` → the daemon-wide `daemon.appendSystemPrompt` → this notice
last. That beats the alternative this plugin shipped with first — prepending
to `initialPrompt` — which turned out to be dead code: the daemon treats a
hook's `initialPrompt` mutation as read-only context and discards it, since
the actual prompt was already resolved and sent independently by the time the
hook runs (`agent-manager.ts`'s `createAgent`). A restricted probe agent on
this exact plugin once got no notice at all as a result, and burned five
`ToolSearch` calls hunting for tools it never had; an earlier one lost 1.1M
tokens the same way. The system-prompt channel also persists across every
turn instead of only the first message, and needs no `initialPrompt` to
attach to, so an interactive agent gets the notice too.

Cost and its limits, stated plainly:

- **`unrestricted` adds nothing.** No notice, no `providerOptions`, no label
  — the request passes through byte-identical. The common path costs zero
  extra tokens.
- **A restricted spawn pays ~80 tokens once.** `read-only`'s notice is 302
  characters, `orchestrator`'s 315 (roughly 76-88 tokens depending on how you
  count). That is the price of not paying for the discovery.
- **The notice names the native Claude tools exactly and the Paseo MCP
  families by group.** Spelling out all nineteen names `read-only` denies —
  most of them `mcp__paseo__`-prefixed and 6-8 tokens each — would cost about
  150 tokens on every restricted spawn, which is the same waste in a
  different pocket. The native tools are the ones an agent reaches for by
  reflex; an agent that tries an MCP family member anyway gets one cheap tool
  error rather than a lost turn. A `custom` profile's notice *is* generated
  from its deny list (the operator chose those names), capped at 12 before it
  summarizes.

#### A denial only holds if every tool with the same reach is denied

`Bash` is not the only way to get a shell. Paseo's own MCP tools can open a
terminal and run anything in it without ever calling a tool named `Bash`: an
agent restricted to `read-only` was observed doing exactly this in
production, using `mcp__paseo__create_terminal` /
`send_terminal_keys` / `capture_terminal` to run `git`, `python3`, and
arbitrary commands after finding its native `Bash` denied. Both enforcement
layers (`disallowedTools` and `settings.permissions.deny`) only ever act on
the exact tool name given to them, so a profile that denies `Bash` without
also denying its MCP equivalents is not actually denying shell access — it
just changes which tool name reaches it.

`orchestrator` and `read-only` therefore also deny:

- The terminal family: `mcp__paseo__create_terminal`, `send_terminal_keys`,
  `kill_terminal`, `capture_terminal`.
- The workspace-script family: `mcp__paseo__start_workspace_script`,
  `stop_workspace_script` — starting a configured `paseo.json` script runs
  whatever that script does, the same reach as a shell.
- The page-interaction browser tools: `mcp__paseo__browser_click`, `_fill`,
  `_type`, `_keypress`, `_select`, `_drag`, `_hover`, `_upload`, `_evaluate`.

`mcp__paseo__list_terminals` and `mcp__paseo__list_workspace_scripts` stay
available under `read-only`: they report state (terminal ids, script status)
and can't execute or mutate anything on their own.

#### The browser is mutation too

An agent holding `mcp__paseo__browser_*` can submit forms, upload local files
to a remote site, and run arbitrary JavaScript in a page that is already
logged in as you. A `read-only` agent with that is not read-only in any sense
an operator would recognise. It went unnoticed for the same reason the MCP
terminal tools did: it is real-world mutation that never touches the local
filesystem, so closing the file and shell tools looked like closing the
question.

The split is deliberate, and different for the two profiles:

- **`read-only` denies the nine input tools** above and **keeps navigation
  and observation** — `browser_navigate`, `_new_tab`, `_close_tab`, `_back`,
  `_forward`, `_reload`, `_list_tabs`, `_snapshot`, `_screenshot`, `_logs`,
  `_scroll`, `_resize`, `_wait`. A reviewer asked to look at a web UI has to
  be able to open a page and see it; a browser it cannot point anywhere is
  not an investigation tool, and a guard rail that makes the job impossible
  gets switched off — which is the failure mode this whole feature is
  recovering from.
- **`orchestrator` denies the whole family, observation included.** A profile
  that cannot `Read` a local file has no business reading a rendered page
  either. Its job is to delegate, not to look.

The honest cost of keeping navigation is stated in the limits below: it is a
real hole, not a claim that navigation is harmless.

`orchestrator` keeps `mcp__paseo__create_agent` and the rest of the
agent-management surface deliberately — delegating to a new, independently
role-resolved, separately-accounted agent is the *entire point* of that
profile (see the leader section below), and coordinating agents, including
ones it didn't create, is what an orchestrator is *for*: cancelling a stalled
run, archiving a finished one, raising a stuck peer's mode, approving a
peer's permission prompt, prompting an existing worker. `read-only` is a
different case, because that role is sold as "cannot do anything harmful" —
so it keeps only `create_agent`, and denies everything else in the family:

- `mcp__paseo__update_agent` is denied by both restrictive profiles, because
  it can rewrite the labels inheritance reads.
- `mcp__paseo__cancel_agent`, `archive_agent`, and `kill_agent` are denied
  under `read-only` because they are purely destructive, aimed at another
  agent's run rather than this agent's own sandbox — "investigate, don't
  change anything" has to include not ending someone else's session.
- `mcp__paseo__set_agent_mode` and `respond_to_permission` are denied under
  `read-only` because both escalate a *peer's* privilege — flipping another
  agent into `bypassPermissions`, or approving its pending permission request
  — which is privilege escalation performed by proxy, exactly what this role
  exists to rule out.
- `mcp__paseo__send_agent_prompt` is denied under `read-only` too. It sends a
  task to *any* running agent by id, not only a child this agent created, so
  the inheritance guarantee below doesn't cover it: the recipient is a peer
  that resolved its own role independently, and if that peer is
  unrestricted, prompting it is a proxy for doing the harmful thing directly
  — that peer could even rewrite this agent's own `paseo.tools-denied` label
  through its own `update_agent`. Both enforcement layers act on exact tool
  names only; there is no way to allow "prompt a child I created" while
  denying "prompt an arbitrary peer" short of denying the tool outright. The
  cost: a `read-only` agent can no longer ask an *already-running* peer to
  act for it. It can still delegate — `create_agent` stays, and inheritance
  guarantees whatever it spawns is at least as restricted as itself — it just
  has to spawn the helper rather than message one that already exists.

`create_agent` itself is not an escalation for either profile: inheritance
(below) forces any child it spawns to be at least as restricted as its
parent, so it cannot be used to launder a restriction away.

#### A child is never less restricted than its parent

`read-only` and `orchestrator` both keep `mcp__paseo__create_agent`, because
delegating to a separately-accounted agent is the point of the whole design.
On its own that makes `read-only` a suggestion: spawn an unrestricted worker,
ask it to make the edit. The earlier argument for keeping `create_agent` —
that a child resolves its own role independently — is only *true* with
inheritance; without it, it is merely hopeful.

So the effective deny list of a child is the union of its own role's profile
and whatever its parent had denied. It only ever accumulates; nothing is ever
subtracted. The parent is the `callerAgentId` on the create request.

**Where the parent's profile is kept, and why there.** On a label
(`paseo.tools-denied`) written onto each restricted agent at its own create,
holding the exact tool names that were denied. The obvious alternative —
reading the parent's persisted `providerOptions` back through `paseo.agents`
— does not exist: `providerOptions` is accepted on `agent.create` and appears
in **no** agent snapshot the daemon will return (`AgentSnapshotPayload` has
no such field), so the thing that actually carries the enforcement is
write-only. Labels are readable, and the plugin was already writing one
(`paseo.model-overridden-by-policy`). The deciding property is durability: a
label survives a plugin reload and a daemon restart, and **activating a plugin
change reloads the plugin** — an in-memory map would forget every live
restricted agent at exactly the moment the operator turned the feature on.

Absence of the label means unrestricted, and that is a fact rather than a
guess: the only thing that can restrict an agent here is this hook, and the
hook always writes the label when it restricts. An agent created while the
plugin was uninstalled carries no denials either. A caller-supplied value of
that label is overwritten, or stripped when nothing was denied, so it always
means exactly what the hook did.

`mcp__paseo__update_agent` is denied by both restrictive profiles for this
reason: it rewrites labels, and an agent that can rewrite its own labels can
erase the record of its own restriction and spawn a clean child.

**Lookups never block a create.** The hook's standing contract is that it
never blocks agent creation, so the parent lookup is synchronous against a
map fed from two places: the `agent.created` lifecycle event (free, covers
everything created since plugin start) and one paginated `paseo.agents.list()`
sweep at plugin start (covers agents that predate it). A miss schedules a
rate-limited background re-sweep and answers from what is known now.

**The two failure modes are deliberately asymmetric.**

- *Directory not loaded yet* (no sweep has succeeded): fail **open**, inherit
  nothing, log. There is no directory for the parent to be absent from, and
  this is the same posture every other cache here takes before its first
  refresh. The window is one RPC round trip after a plugin start.
- *Directory loaded, parent not in it*: fail **safe**. A live agent is making
  this create, so its absence is a contradiction, and granting a clean child
  on a contradiction is the exact silent escalation inheritance exists to
  stop. The child gets the `read-only` floor — not `orchestrator`, so it can
  still investigate and say so — and the restriction notice tells it what
  happened.

**None of this runs unless some role is actually restricted.** The lookup is
gated on the policy having at least one role that denies something. With
every role `unrestricted` (the shipped default) there is nothing to inherit,
so no lookup happens, no RPC is issued, and the request is byte-identical.

### What a tool profile does and does not guarantee

**It is not a sandbox, and it cannot be made into one.** A profile is a
launch-time edit to the tool surface the Claude Agent SDK offers one session:
`disallowedTools` removes named tools from the model's context, and
`settings.permissions.deny` refuses named tools at the permission layer. Both
act only on exact tool names this code knows to write down. Everything below
follows from that, and every item is open today.

**What it does guarantee.** For the tools Paseo registers and the ones Claude
ships natively, a denial is real and the agent cannot lift it —
`update_agent_request` accepts only name, labels and runtime settings, so a
spawned agent cannot rewrite its own `providerOptions`. A child cannot come
out less restricted than its parent. The applied deny list is recorded on the
agent's own `paseo.tools-denied` label, so what was enforced is auditable
after the fact. `read-only` denies the whole agent-lifecycle family —
`update_agent`, `cancel_agent`, `archive_agent`, `kill_agent`,
`set_agent_mode`, `respond_to_permission`, `send_agent_prompt` — keeping only
`create_agent`, which inheritance keeps from being an escape hatch. A
`read-only` agent cannot kill, archive, or mode-flip another agent, approve
another agent's pending permission, or prompt any already-running agent,
including one it spawned itself; see the per-tool breakdown above (just
before "A child is never less restricted than its parent") for the reasoning
and the cost that closure carries. `orchestrator` keeps the whole family on
purpose — coordinating agents is its job — so this guarantee is specific to
`read-only`.

**What it does not guarantee.**

- **MCP servers outside Paseo's registry are invisible to this code.**
  Anything configured in the agent's own `~/.claude` setup — a filesystem
  server, a database server, a shell server, a deploy tool — is a set of tool
  names this plugin has never seen and therefore never denies. If your MCP
  configuration exposes file writes or command execution under some other
  server's name, a `read-only` role does not stop it. This is the single
  biggest gap, and no amount of work inside this plugin closes it: the deny
  lists here are a finite list of names, not a capability model.
- **`browser_navigate` and `browser_new_tab` remain under `read-only`.** They
  take a URL, and a GET issued from a browser session that is already
  authenticated as you can change server state (`…/admin/delete?id=5` is
  still a GET on plenty of systems). Kept because the alternative is a
  reviewer that cannot look at the thing it is reviewing. Use a `custom`
  profile that also denies them if that trade is wrong for you.
- **`WebFetch` and `WebSearch` are denied by no profile.** A `read-only`
  agent can reach the network directly.
- **There is a fail-open window at plugin start.** Until the first agent
  directory sweep succeeds — one RPC round trip after the plugin starts — a
  parent's restrictions are unknown and nothing is inherited. Creates in that
  window get their own role's profile and no more.
- **A guessed role never restricts tools at all.** Tier-3/4 classification
  picks a model but not a profile (see below). If you want a role restricted,
  label the agent.
- **Nothing here constrains the process.** A profile shapes one session's
  tool list. It does not stop hooks configured in the operator's own Claude
  settings, processes started before the restriction applied, or anything the
  provider CLI does outside the tool layer.

An operator who trusts a guarantee this feature does not make is worse off
than one who knows exactly where the boundary is. It is guard rails: it stops
an agent wandering off the road. It is not a fence, and it is not a cage.

### The leader role, and why restricting it forces real delegation

`leader` governs **root agents**: creates with no `callerAgentId`, i.e. the
ones a human, the CLI, the app, a schedule, or a heartbeat starts. Everything
those agents spawn resolves its own role as usual.

It is deterministic, not classified — a root agent is the leader by
definition, and guessing from its prompt would make whether your restriction
applies depend on wording. For the same reason the leader role is excluded
from automatic text classification, so a child whose prompt happens to mention
leading something doesn't inherit it. Naming it explicitly (an agent-type
mapping, or the `paseo.agent-role` label) still selects it.

The point of restricting the leader is that **it is the only thing that
forces spend onto another account.** Claude Code's native subagents (`Task`)
do not get their own `agent.create`: they run as sidechains inside the
parent's session, on the parent's account, and their tokens land in the
parent's usage window. Paseo has no hook on them. Only a full Paseo
`agent.create` — `mcp__paseo__create_agent` — moves work to a different
account.

So a leader that can still read files, run shell commands, or spawn native
subagents will keep doing the work itself and keep spending its own budget, no
matter how the roles beneath it are configured. The `orchestrator` profile is
what makes delegation the only option left.

The leader role ships unconfigured and unrestricted: installing this changes
nothing until you set it up.

### A guessed role may pick a model. It may not take tools away.

The classifier resolves every non-root create's role in one of four tiers,
most to least direct:

1. An explicit `paseo.agent-type` label mapped in `agentTypeMappings`.
2. An explicit `paseo.agent-role` label naming a role by name/alias.
3. Automatic classification: the title + initial prompt matched against
   configured role names/aliases, then against the built-in `reviewer`/
   `advisor` seed vocabulary (words like "review", "verify", "check",
   "research", "investigate"). The decision reports which of the two matched
   — `classified-vocabulary` or `classified-seed` — because "your own alias
   caught this" and "a built-in keyword did" are the first thing asked when
   a classification surprises someone.
4. The bare default (`worker`), when there's no title/prompt text to
   classify at all.

Tiers 1 and 2 are the caller stating its role outright — real evidence. Tiers
3 and 4 are guesses from free text, and an ordinary implementation brief
routinely contains words like "check" or "verify" ("check types and verify
tests pass before committing") without being a review task at all. The
`leader` role for root agents sits outside this ladder entirely: a root agent
(no `callerAgentId`) genuinely *is* the leader by definition, so its
resolution is deterministic, not classified (see the leader section above).

**Model selection uses all four tiers; tool enforcement only trusts tiers 1,
2, and the deterministic leader tier.** The two decisions don't carry the
same risk: a wrong model guess costs a little quality, while a wrong tool
guess can silently take `Write`/`Edit`/`Bash` away from an agent that has
already started a task, discovered only when it tries to use them and can't
— the exact failure that motivated this rule. So a role resolved by tier 3 or
tier 4 still picks its configured model as normal, but its `toolProfile` is
withheld in favor of `unrestricted`, and the substitution is logged (once per
caller+role) so it's discoverable rather than a silent, unexplained
capability loss.

**Practical consequence: if you want a restricted role, label it.** Don't
rely on the classifier inferring `reviewer` or `advisor` from wording alone —
set `paseo.agent-type` (or `paseo.agent-role`) explicitly on any agent you
spawn that should actually be tool-restricted. An agent-type mapped to a
restricted role, or a role named directly via the label, is enforced exactly
as configured; anything classified from free text is not.

There is an escape hatch for operators confident enough in their own
classification vocabulary to want the old (riskier) behaviour anyway:
`enforceToolsOnClassifiedRoles`, a policy-level boolean, default **off**.
When on, tiers 3 and 4 enforce their resolved role's tool profile too, with
no distinction from an explicit label. It isn't exposed on the settings
screen yet — set it directly on the stored `agentModelPolicy` document if you
need it.

### Asking before you spawn

A caller can ask the classifier what a task *should* run as, before it creates
anything, through an MCP tool named `agent_model_policy`. It takes the labels,
title, prompt and model you would use, and answers with the whole decision
plus the labels that would make it explicit rather than guessed.

`@getpaseo/plugin` has no "register an agent tool" API. What a plugin *can* do
is rewrite `config.mcpServers` on `before("agent.create")`, which the daemon
honors end to end, so this plugin contributes an agent tool by injecting an
MCP server it ships itself.

The MCP server runs **in the plugin process**, on a unix socket
(`server/classifier-tool.ts`); the child the daemon spawns is a byte pipe with
no logic in it. That is the fork's own pattern for a daemon-hosted MCP server
— see `packages/server/scripts/mcp-stdio-socket-bridge-cli.mjs` — and it is
what makes the tool's answer and the create hook's behaviour literally the
same call, against the same catalog, pool and health, rather than two things
that agree for now.

**A plugin cannot ship that child as a file.** The daemon compiles a plugin to
one CJS bundle and evaluates it with `globalThis.eval`, so there is no module
URL, no `__dirname`, and `import.meta.url` is `undefined` — a top-level
`new URL("./mcp/bridge.mjs", import.meta.url)` throws `TypeError: Invalid URL`
while the bundle loads and takes the entire plugin down, which is exactly what
happened the first time this shipped. The `initialize` message carries
`pluginId`, `bundle`, `appVersion` and `settingsDirectory`, and nothing that
locates the plugin on disk. So the bridge travels as a string in the bundle
and is written into the socket's own private temp directory when the tool is
switched on. `packages/server/src/server/plugins/account-pool-plugin-load.test.ts`
compiles and evaluates this plugin the way the daemon does, so a module-scope
mistake of that shape fails a test instead of a fleet.

**Off by default.** Set `exposeClassifierTool: true` on the stored
`agentModelPolicy` document to turn it on. Enabling it changes the
`mcpServers` of every agent the daemon creates, which is not something an
upgrade should do quietly. It exposes the operator's routing policy to agents
already running on the operator's machine, and nothing else — the socket
carries no credentials and answers only this one question.

While it is off, **none of this code runs**: no socket is opened, no temp
directory is made, no bridge is written. The feature starts on the first
create that sees the flag set, and policy is re-read on every create, so
switching it on takes effect on the next spawn. That is load-bearing rather
than tidy — the version that ran one line of it unconditionally is the version
that took the plugin down.

### Fable budget gate

> Fable is currently retired from every pool — Opus 5.5 supersedes it, so
> nothing routes there. The gate below stays in the code because the decision
> is an operator's to make, not a schema change: put a Fable entry back in a
> pool and it starts applying again. `server/classifier.test.ts` asserts that
> no configured pool names it.

Fable is the expensive escalation model. When every pooled account is at or
above a threshold share of its weekly Fable window, roles skip their Fable
entry and fall to the next model **in their own pool**, so the cap lands at a
model boundary rather than mid-task.

Configured from the settings screen ("Step off Fable at"), default 80%. The
gate reads window *utilization* rather than the coarser healthy/drained/capped
status, so it can act before the cap. An account with no usage reading yet is
treated as within budget — a missing poll must not silently downgrade every
role's top model.

Only Fable is gated. The everyday families are the pool's normal traffic, and
a soft threshold there would churn the common path for no benefit, since their
hard cap already evacuates them.

Following pi-roles: an exhausted pool never borrows. A role whose every entry
is gated out falls back to its own `models[0]` rather than another role's pool
or whatever model the parent happened to be running.

### Failure behaviour

The role hook never blocks agent creation. Malformed policy, an unreadable
daemon config, a vanished provider, an unknown declared role — every one of
them passes the request through and logs, rather than failing the create.

The account router has exactly one case that does block: every pooled account
capped, with the evidence to prove it. See [No account left](#no-account-left)
for why that one is worth the exception.
