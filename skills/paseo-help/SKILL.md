---
name: paseo-help
description: Answer questions about the Paseo product and app, including setup, configuration, connectivity, providers, workspaces, updates, logs, and troubleshooting. Use when a user inside Paseo asks how Paseo works, how to configure it, or why something is broken; use the paseo skill instead to operate agents and workspaces through MCP or the CLI.
---

# Paseo Help

You are helping a user understand, configure, or troubleshoot Paseo itself. Answer their question directly, verify the answer against the current public documentation, and include the relevant documentation link. Do not send the user away to read the docs in place of helping them.

**User's question:** $ARGUMENTS

## Use current documentation

Fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt) first. It is the current index of Paseo documentation, with a description and Markdown URL for each page.

Use that index to select the page that owns the user's question, then fetch the linked `.md` page before answering. For troubleshooting, begin with [Common problems](https://paseo.sh/docs/troubleshooting.md) and follow its links when the issue belongs to a more specific page.

Prefer the deployed docs over memory. Answer the user directly, then link the relevant `.md` page as supporting documentation.

## Establish the topology first

Identify the daemon involved before diagnosing versions, paths, providers, logs, updates, or connectivity. Do not infer the daemon from the client: Paseo Desktop can manage its bundled local daemon and connect to other remote daemons at the same time.

Establish two facts:

1. **Where and how the daemon runs**
   - **Desktop-managed:** Paseo Desktop bundles, starts, and updates a daemon on that computer. No separate daemon install is required.
   - **Standalone:** the daemon was installed separately, commonly through the npm CLI, and runs independently of the desktop app.
   - **Docker:** the daemon, its home, provider CLIs, credentials, and code mounts live in the container runtime.
2. **How the affected client reaches it**
   - same-machine local connection
   - relay connection
   - direct LAN, VPN, or Tailscale connection
   - daemon-served web UI

Use **Settings → About** to compare the app version with each connected host. For the affected host, open **Settings → your host → Overview → Full status**. On the daemon machine, `paseo daemon status --json` reports facts such as server ID, hostname, version, home, listen address, process owner, log path, and whether the daemon is desktop-managed.

Record which host the user is viewing and which machine or container runs it. A local `paseo daemon status` describes the daemon for that CLI's local `PASEO_HOME`; it may not be the remote host visible in the app.

Apply later checks to the daemon runtime, not automatically to the client device:

- Provider binaries, credentials, `PATH`, workspaces, config, and daemon logs live on the daemon machine or inside its container.
- App version and app logs live on the client device.
- A desktop-managed daemon follows the Desktop app lifecycle and update path.
- A standalone daemon follows its own CLI/npm lifecycle and may use a different `PASEO_HOME` or listen address.
- A Docker daemon uses container paths, volumes, user permissions, image versions, and container lifecycle commands.

## Diagnose before changing state

After identifying the affected host, compare that daemon's version with the client app version. Ask the user to update both through the correct topology-specific update path. Old versions and app/daemon version skew cause many apparent bugs, and fixes ship frequently. Use the Updates page and the installation-specific docs for current instructions.

Use the smallest relevant read-only checks:

```bash
paseo --version
paseo daemon status --json
paseo provider diagnostic <provider> --json
```

Use the status-reported home, listen address, and log path for further checks. Probe `http://127.0.0.1:6767/api/health` or read `~/.paseo/daemon.log` only when those values match the affected daemon. Do not restart the daemon, edit config, update software, or expose a network listener without the user's explicit permission. A daemon restart can interrupt the agent doing the diagnosis.

For a missing provider or `command not found`, run `paseo provider diagnostic <provider>` against the affected host, or open **Settings → your host → Providers → provider → Diagnostic**. Compare its resolved binary, daemon `PATH`, and provider version with a brand-new login shell. Shell aliases and functions are not executable paths.

## Logs and local files

Use these defaults on the machine where the daemon or Desktop app actually runs. Do not look for a remote daemon's files on the client device.

- Daemon config: `~/.paseo/config.json`
- Daemon log: `~/.paseo/daemon.log`
- Agent state directory: `~/.paseo/agents/`
- Default managed worktree root: `~/.paseo/worktrees/`
- macOS desktop log: `~/Library/Logs/Paseo/main.log`
- Linux desktop log: `~/.config/Paseo/logs/main.log`
- Windows desktop log: `%APPDATA%\Paseo\logs\main.log`

Substitute the status-reported `PASEO_HOME` for `~/.paseo`. In the official Docker image, the default is `/home/paseo/.paseo`; its host path depends on the volume mount, and container stdout is available through Docker. Desktop app logs describe the Desktop process; daemon logs describe the selected daemon. Read the narrowest useful slice and redact credentials, pairing offers, tokens, passwords, and user code before sharing logs.

If diagnosing the bundled daemon on a computer with Paseo Desktop installed, but `paseo` is not on `PATH`, the bundled CLI is at:

- macOS: `/Applications/Paseo.app/Contents/Resources/bin/paseo`
- Linux: `<install-dir>/resources/bin/paseo`
- Windows: `C:\Program Files\Paseo\resources\bin\paseo.cmd`

Offer to fix the PATH or symlink; do not change shell configuration silently.

## This checkout is a fork, and the deployed docs do not describe it

`funkmastert/paseo` is **Bozeo**, a fork of `getpaseo/paseo`. Before answering from
paseo.sh, check whether the question touches something the fork changed.

- **Branch.** The work is on `multi-account-orchestrator`. `main` is an unmodified copy
  of upstream, so a checkout of `main` reproduces none of the behaviour below.
- **Precedence.** For anything fork-specific, this repository's `docs/`,
  [docs/install.md](../../docs/install.md) and
  [plugins/claude-account-pool/README.md](../../plugins/claude-account-pool/README.md)
  win over paseo.sh. Upstream docs know nothing about the Bozeo branding, the
  `claude-account-pool` plugin, the `/install` command, or JEV. Quoting them on those
  topics produces confident wrong answers.
- **Install.** Follow `.claude/commands/install.md`; it automates `docs/install.md` and
  is authoritative on ordering and consent.

### Settle the direction and the address before diagnosing

Two questions, in this order, before touching any config:

1. **Which way does the connection go?** A client connects _out_ to a daemon. To see
   machine B's sessions on machine A, **B's daemon** must be reachable — making A
   reachable does nothing for it. Getting this backwards sends you scanning ports on the
   wrong host.
2. **Is a daemon actually at that address?** Run
   `node scripts/check-remote-host.mjs <host[:port]>`. It prints the Host, Port and
   Use SSL to enter, or why the address will fail. HTML on `/` is not evidence: the web UI
   is static assets and a tunnel can serve them with no daemon behind the WebSocket. Only
   a `/ws` upgrade proves one.

Cross-machine visibility is usually the **relay**, which the daemon dials out to — not
Tailscale and not an open port. A fresh home disables the relay, so "it used to see my
other machines" most often means relay got switched off, not that a listen address is
wrong.

### A replaced home is three stores, not one

`~/.paseo` is only the daemon's. The **app profile**
(`~/Library/Application Support/<productName>`) holds the **host list**, and
`~/.paseo/projects/{projects,workspaces}.json` holds the **workspace registry**. A
rebrand renames the profile directory, so a renamed app starts with no hosts even though
the old profile is intact on disk — which reads exactly like a broken connection. An
unrestored registry makes every workspace read "unavailable". See
[docs/install.md](../../docs/install.md#replace-an-existing-install); the profile can be
migrated only because both apps keep the `paseo://` scheme, so never rename it.

### Fork gotchas worth checking before diagnosing

Each of these has cost real time. They look like different bugs than they are.

- **Node.** The repo needs Node 22, and the machine's default `node` may be older. A
  version manager only applies to shells that load it, so load it in every shell —
  including before `git commit`, because lefthook's `pre-commit` runs `oxlint` and
  `oxfmt` and fails with `ERR_UNKNOWN_FILE_EXTENSION` under an old Node.
- **An existing `~/.paseo` blocks a fresh install** even with no daemon running;
  preflight reports `EXISTING INSTALL OR BUSY PORT`. Agent history does **not** transfer
  to a new home, and copying `agents/` back does not restore it.
- **A new home cannot be reached off-box.** It is written with relay off and
  `daemon.listen: 127.0.0.1:6767`. A phone or another machine reaching it is a
  configuration change, not a fault. A tailnet address cannot be bound while Tailscale is
  down; `0.0.0.0` needs `daemon.auth.password` on untrusted networks.
- **Pool sign-in silently cross-signs.** `--email` only pre-fills the page: with a live
  claude.com session the authorize step completes against that account. Verify `orgId`,
  not just `email` — matching orgs mean the pool has fewer accounts than entries and is
  treating one budget as several.
- **The app shows one host at a time**, and remote hosts are added in the app UI only —
  not in `desktop-settings.json`, not from the CLI. An empty session list after a fresh
  install is expected, not a broken connection. `paseo ls` also hides archived agents
  unless you pass `-a`.
- **Quitting the app stops the daemon.** The defaults are `manageBuiltInDaemon: true` and
  `keepRunningAfterQuit: false`, so quitting takes every running agent with it. Use a
  CLI-started daemon or a launch agent for an always-on host.
- **JEV is off until `PASEO_JEV_API_KEY` exists** in `~/.config/paseo/jev.env`
  (`chmod 600`). It is read through a 5-second cache, so no restart is needed. The service
  logs `jev: off, no key` **once per process**, so an existing line in the log is not
  evidence the key is still missing — compare the line's `pid` against the running daemon,
  or check that a restarted daemon added no new line.
- **Do not promise CI.** `ci.yml` and `nix.yml` trigger only on pull requests into `main`,
  so a PR based on `multi-account-orchestrator` runs nothing, and Actions has been
  disabled on the fork (`workflow run` returns HTTP 422). Verify locally and say so.

## Escalate with evidence

If the current docs and diagnostics do not resolve the problem, collect the app and daemon versions, OS, install method, connection method, exact error, minimal reproduction, and a small redacted log excerpt.

- Bugs: [GitHub Issues](https://github.com/getpaseo/paseo/issues)
- Questions and quick help: [Paseo Discord](https://discord.gg/jz8T2uahpH)
- Product workflow discussions: [GitHub Discussions](https://github.com/getpaseo/paseo/discussions) or `#product` in Discord
