# claude-account-pool

Routes agent-created subagents across a pool of Claude accounts instead of a
single provider entry, so a subagent that would otherwise fail on a rate
limit or credential problem can fall through to another account.

This unit (U4) ships only the pool-config contract and its loader. Nothing
routes traffic yet — that lands in later units (health tracking, then the
router itself).

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

## What this unit provides

- `shared/pool-config.ts` — the Zod schema for `params.accountPool` and
  `resolvePool()`, which turns a set of provider entries into an ordered
  worker chain plus one leader.
- `server/pool.ts` — `loadPool()` reads daemon config through the plugin's
  `paseo.config.get()` API and resolves it into a pool, and
  `createPoolCache()` wraps that in a cached, interval-refreshed accessor.

See those files' doc comments for the exported API later units build on.
