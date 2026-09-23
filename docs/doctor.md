# Doctor

`paseo doctor` finds the failures this fork has already paid for once. Each check exists because something broke silently and cost hours: an account with no `CLAUDE.md`, a plugin that failed to load, a daemon older than the app bundle beside it. A check that only says "the daemon is up" does not belong here.

It diagnoses and never mutates. It does not write config, credentials, symlinks, worktrees or agents, and it does not run the fix it prints. `resolvePaseoHome` and `loadPersistedConfig` both create or chmod things, so doctor reads `config.json` itself (`session/doctor/facts.ts`). Keep that when you add a check: read, compute, print the command. `session/doctor/doctor.test.ts` snapshots a broken fixture tree before and after every check and fails on any difference.

## Where it runs

The checks live in `packages/server/src/server/session/doctor/` and run in the daemon over `daemon.doctor.request`, gated on `server_info.features.daemonDoctor`. Inside the daemon the config schema, plugin runtime, agent list and process start time are the real ones.

A daemon that predates the RPC, or none at all, still gets a run. The CLI (`packages/cli/src/commands/doctor.ts`) runs the same checks against the same files, with daemon state pulled through RPCs every daemon answers, and says so in the report. Two things degrade in that mode:

- **Config keys** are checked against the CLI's schema. A key the CLI knows and the daemon does not is the failure that matters, and it is not caught. The report says so as its own warning.
- **Workspace base branches** come from `projects/workspaces.json` on disk instead of the registry.

## Checks

| Id                                              | Catches                                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.claude-md`                             | A Claude config dir used by a provider with no `CLAUDE.md`, a broken link, or a private copy. Canonical is `~/.claude/CLAUDE.md`.                                      |
| `account.projects-link`                         | `projects/` not resolving to `~/.claude/projects`. A private one strands a session moved between accounts.                                                             |
| `account.login`                                 | Signed out, never signed in, credential missing, or two dirs signed into one login.                                                                                    |
| `account.budget`                                | A usage window at 90% (warn) or 100% (fail), or usage unreadable.                                                                                                      |
| `plugin.status`                                 | A configured plugin that failed, never loaded, or runs from a path that is gone; `pluginsEnabled: false` with plugins configured.                                      |
| `daemon.build`                                  | The bundle staged after the daemon started, or a version mismatch. Compares against the app the daemon runs from, else `Bozeo`/`Paseo`.                                |
| `config.keys`                                   | Keys the running build's strict schema rejects. Reads the daemon's own `PersistedConfigSchema`.                                                                        |
| `mcp.gateway`                                   | OAuth servers behind the gateway with no stored login. Critical servers fail.                                                                                          |
| `skills.mirror`, `skills.lint`, `skills.bundle` | A pool account's `skills/` that drifted from `~/.claude/skills`; skills naming paths in directories that are gone; Paseo-installed skills out of sync with the bundle. |
| `disk.free`                                     | Free space below `agents.artifactJanitor.diskGuard.minFreeBytes` (default 20 GiB) fails; below 1.5x warns.                                                             |
| `worktrees.size`, `worktrees.reclaimable`       | Count and size of `<home>/worktrees/*/*`, and which are clean, merged or pushed, unpinned and have no live agent.                                                      |

Every finding carries what is wrong, why it matters and the exact command. A check that finds nothing wrong reports one `ok` line, so a passing run still shows what it looked at (`--full`).

## Things that are not obvious

- **Credentials are checked by presence, never by value.** On macOS the item is `Claude Code-credentials-<sha256(configDir)[:8]>`. A provider that sets `CLAUDE_CONFIG_DIR` gets the hashed item even when the dir is `~/.claude`; only a run with no `CLAUDE_CONFIG_DIR` uses the plain `Claude Code-credentials`. Doctor tries the hashed name first, then the plain one. `security find-generic-password -s` with no `-w`/`-g` never prints the secret. The keychain says nothing about whether the token still works; the usage windows are the check for that.
- **Each check has its own deadline** (`runner.ts`). A hung check becomes a `skip` carrying `timedOutAfterMs` and nothing else changes. That is deliberate: v0.5.14 of OpenRig reported a healthy daemon as down because one pre-flight had a shorter deadline than the request it guarded. Never mark the daemon down because one check was slow.
- **Daemon-side inputs are gathered before the checks run**, so each has a 10 s cap (`doctor-session.ts`). A wedged usage fetch would otherwise hold the whole answer.
- **The worktree sweep is the long pole.** `du` over 130 worktrees took 55 s cold on the machine this was built on. The quick run gets 25 s and says "measured N of M" when it runs out; `--deep` gets 5 minutes. Idle worktrees are checked first, so a partial sweep still finds the reclaimable ones. It runs at most three at a time because git goes through the daemon's shared process scheduler.
- **Reclaimable uses the done janitor's git gate** (`done-janitor-worktree.ts`, read-only), plus "no live agent" and "not pinned". "Merged" there means every commit is on a remote-tracking ref or the recorded base branch. A squash-merged branch whose remote is gone is kept.
- **A path in a skill is only flagged when its directory is gone.** A file inside a directory that exists is usually something a tool writes at run time. A missing directory is a moved project. `/home/...` is ignored off Linux.
- **An unknown key in `config.json` is worse than it looks.** In a test daemon, writing one to the file on disk made new client connections hang, not just the next restart. Add a key to `config.json` only after the daemon reading it is running (see the collision rules in the OpenRig port plan).

## Adding a check

Add a `DoctorCheck` in `session/doctor/`, register it in `runner.ts`, and give it a `timeoutMs`. Read facts from `DoctorContext`: the filesystem through paths built from `ctx.home` and `ctx.paseoHome`, everything the daemon knows through `ctx.facts`. Do not import daemon singletons; the CLI runs the same code without them. Emit the exact fix as a string. Test it against a temp `HOME` from `test-support.ts`.
