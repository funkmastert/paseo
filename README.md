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

### An explicit model request wins, but only within the role's own pool

A caller can ask for a specific model directly (`mcp__paseo__create_agent`'s
`provider` field as `provider/model`, or `config.model` on a session create).
The role router's precedence:

1. **The explicit request wins when it's a member of the resolved role's own
   pool** — the caller is choosing among models the operator already
   approved for this role, which policy should allow. The request passes
   through untouched: model, provider, and account all stay exactly what was
   asked for.
2. **Policy wins otherwise.** The role's own ordered selection runs as usual
   and the request is rewritten to it — but the override is never silent:
   it's logged (`role-router: caller "…" explicitly requested "…", which is
   not in role "…"'s pool; policy overrode it to "…"`), the created agent
   gets a `paseo.model-overridden-by-policy` label carrying the ref that was
   asked for, and the `role-model-policy.explain` RPC accepts optional
   `requestedModel`/`requestedProvider` fields so the settings screen can
   simulate the same decision (`requestedModelOverride: { requestedRef,
   honored, effectiveRef? }`).

"Member of the pool" means the requested `(provider, model)` matches one of
the role's own configured entries by family — an account-agnostic entry
matches any pooled account's provider id, the same way normal selection
does. It is a literal-membership check, not a live-availability one: an
approved model that's currently catalog-missing or capped everywhere is
still honored if explicitly requested, exactly as a caller who set
`config.model` directly always could before role tool-profile enforcement
existed. A role with no configured pool at all has nothing to override, so
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
| `orchestrator` | `Read`, `Glob`, `Grep`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`, `Task`, `Agent` |
| `read-only` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash` |
| `write` | Nothing — file and shell tools are the point of this profile. |
| `custom` | Whatever you list. |

`read-only` denies `Bash` because a shell redirect writes files just as well
as `Write` does. A custom profile's *pre-approve* list only skips permission
prompts; it cannot re-enable a denied tool, since `disallowedTools` has
already removed it.

Restrictions only accumulate. Whatever the caller already denied stays denied
— a plugin that can silently widen a caller's own sandbox would be a worse bug
than an unenforced role.

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
