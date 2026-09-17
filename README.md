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

See [Role policy](#role-policy) for the second half — model pools, tool
enforcement, the leader role, and the Fable budget gate.

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

`role` is `"leader"` or `"worker"`. `priority` is a positive integer; lower
priority numbers are preferred first among workers. There must be exactly one
`leader` entry — it is the last-resort target once every worker has been
tried, and the anchor for pool-exhaustion notifications. Worker priorities
must be unique. Malformed or missing `accountPool` config anywhere in
`agents.providers` makes this plugin fail open: it treats the pool as empty
and steps out of the way rather than blocking agent creation.

### 2. Apply the config change

`agents.providers` is one of the daemon's reloadable config paths, but it is
not picked up automatically when you edit `config.json` on disk — run
`paseo reload` after saving to apply the new entries without restarting the
daemon. A full daemon restart is not required.

### 3. Install the plugin

```bash
paseo plugin install /Users/tylerthackray/paseo-plugins/claude-account-pool
paseo plugin ls
```

Plugins are unsandboxed, trusted code: this plugin's server code runs with
the daemon user's access on the daemon host.

## Role policy

Stored under the top-level `agentModelPolicy` key in daemon config, edited
from the **Agent Model Policy** settings screen. A role is resolved for every
`agent.create`, and decides two things: which model the agent runs, and which
tools it may use.

The policy model (roles, aliases, ordered model pools, explicit agent-type
mappings, and their precedence) is ported from
[pi-roles](https://github.com/wonderlydotcom/pi-roles); see its
`docs/roles-protocol.md`. What follows is only what differs or is new here.

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

### An explicit model request wins, but only when it's currently selectable

A caller can ask for a specific model directly (`mcp__paseo__create_agent`'s
`provider` field as `provider/model`, or `config.model` on a session create).
The role router's precedence:

1. **The explicit request wins when it's a member of the resolved role's own
   pool AND currently selectable** — the same eligibility bar ordered
   selection holds every other candidate to: present in the live catalog, a
   viable pool member, and (for Fable) under the budget threshold. The
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
  configured entries, but isn't selectable right now (catalog-missing, no
  viable pool member, or gated by the Fable budget threshold). This is
  deliberately treated as an override rather than honored as-is: the
  failure this exists to prevent is an agent spawned onto an account/model
  with no budget left, dying on its first turn. A caller who asked for an
  approved model that's temporarily unavailable gets policy's live
  selection instead, with a message that says so — not the same message as
  a caller who asked for a model the role forbids.

"Member of the pool" means the requested `(provider, model)` matches one of
the role's own configured entries by family — an account-agnostic entry
matches any pooled account's provider id, the same way normal selection
does. A role with no configured pool at all has nothing to override, so
every explicit request passes through untouched, matching the "unconfigured"
pass-through behaviour above.

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
| `orchestrator` | `Read`, `Glob`, `Grep`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, the Paseo terminal/workspace-script MCP tools below, `Task`, `Agent` |
| `read-only` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, the Paseo terminal/workspace-script MCP tools below |
| `write` | Nothing — file and shell tools are the point of this profile. |
| `custom` | Whatever you list. |

`read-only` denies `Bash` because a shell redirect writes files just as well
as `Write` does. A custom profile's *pre-approve* list only skips permission
prompts; it cannot re-enable a denied tool, since `disallowedTools` has
already removed it.

Restrictions only accumulate. Whatever the caller already denied stays denied
— a plugin that can silently widen a caller's own sandbox would be a worse bug
than an unenforced role.

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

`mcp__paseo__list_terminals` and `mcp__paseo__list_workspace_scripts` stay
available under `read-only`: they report state (terminal ids, script status)
and can't execute or mutate anything on their own.

`orchestrator` keeps `mcp__paseo__create_agent` and the rest of the
agent-management tools deliberately — delegating to a new, independently
role-resolved, separately-accounted agent is the *entire point* of that
profile (see the leader section below). This does mean a `read-only` or
`reviewer` agent that still has `create_agent` can spawn an unrestricted
child and ask it to make the edit it wants. That is not treated as a hole
here: the spawned child resolves its own role and runs on its own account
through the same `agent.create` hook, which is exactly the sanctioned
"delegate, don't do it yourself" path the whole leader/orchestrator design
depends on — closing it would mean denying delegation itself, not closing an
accidental escape. The same reasoning applies to `mcp__paseo__send_agent_prompt`:
an agent that already knows another agent's id can ask it to do something,
but that is asking a (separately authorized) peer, not executing anything
itself.

**This is not, and cannot be made, airtight.** Two things are explicitly out
of scope and left open:

- **Browser automation** (`mcp__paseo__browser_*`) is not denied by any
  built-in profile. `browser_click`/`browser_fill`/`browser_type`/
  `browser_upload`/`browser_evaluate` can submit forms, upload files, and run
  arbitrary JavaScript in a page — real-world mutation, just not to the local
  filesystem or shell. If you need a profile that can investigate without
  being able to act on the open web, build a `custom` profile that also
  denies the `browser_*` tools you don't want.
- **MCP servers outside this plugin's registry** (anything configured in the
  agent's own `~/.claude` config, not Paseo's) are invisible to this code
  entirely. `disallowedTools`/`settings.permissions.deny` can only deny tools
  by name; if an operator's own MCP setup exposes a shell or file-mutation
  tool under some other server's name, no profile here knows to deny it. A
  `read-only` or `orchestrator` role is a guarantee about Paseo's own tools
  and Claude's native ones — not a sandbox over everything an agent's MCP
  configuration can reach.

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

`resolveRole` resolves every non-root create in one of four tiers, most to
least direct:

1. An explicit `paseo.agent-type` label mapped in `agentTypeMappings`.
2. An explicit `paseo.agent-role` label naming a role by name/alias.
3. Automatic classification: the title + initial prompt matched against
   configured role names/aliases, then against the built-in `reviewer`/
   `advisor` seed vocabulary (words like "review", "verify", "check",
   "research", "investigate").
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

### Fable budget gate

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
