---
description: Install Bozeo from source — prerequisites, build, the fork's CLI, the account pool plugin, Claude account sign-in, and a final doctor check
---

# Install Bozeo

## Purpose

Get this checkout to a working Bozeo: the fork's daemon and CLI running, the
`claude-account-pool` plugin installed, at least one Claude account signed in
per role, and `paseo doctor --full` green. This is an interactive, agentic
process — ask the user when a step is a real choice, and never act on their
behalf where a browser login is required.

## Source of truth

This command automates [docs/install.md](../../docs/install.md) and
[plugins/claude-account-pool/README.md](../../plugins/claude-account-pool/README.md#operator-setup).
Where anything here seems to disagree with them, they win — re-read the doc
section named at each step rather than trust this file's memory of it.

## Variables

- `REPO_ROOT`: the directory this command runs from (the checkout root).
- `DEFAULT_PORT`: `6767`.
- `DEFAULT_HOME`: `~/.paseo` (`%USERPROFILE%\.paseo` on Windows).
- `PLUGIN_DIR`: `plugins/claude-account-pool`.

## Instructions

- Run every check through the shell. Assume nothing is installed.
- Print a pass/fail status line immediately after each check.
- Auto-install what can be auto-installed (`npm ci`, the build). Ask the user
  only for real choices: whether to also build the desktop app, and the
  account-pool topology (how many workers, which `CLAUDE_CONFIG_DIR` paths).
- **Never cat, grep, or echo a credential file or its contents.** A presence
  check prints only a name and `SET`/`unset`, or an account name and
  `signed in`/`not signed in` — never a value. This rule exists because a
  failed `sed` redaction once leaked a full API key into a transcript.
- **Never run `claude /login` for the user.** It opens a browser; print the
  exact command and wait for them to run it themselves.
- **Stop-and-ask gate.** Before any step that would start a daemon or write
  `~/.paseo/config.json`: if a daemon is already reachable on the target port,
  or `~/.paseo` already exists, stop and ask how to proceed (see Step 2).
  Never overwrite `config.json` — merge into it only after showing the diff
  and getting explicit consent.
- Never restart, stop, or reload a daemon this command did not itself start.
- Never run `npm run dev`, `npm run dev:desktop`, or open the packaged app from
  this command — those block a terminal or open a GUI a script can't drive.
  Starting the fork's own background daemon with `paseo daemon start` is
  different: it detaches immediately, it's how the plugin's own operator
  setup verifies itself, and there's no "working Bozeo" without it running.
- Finish with `paseo doctor --full`, the plugin README's own documented check.
  Do not run the project's test suite from this command — this repo's own
  rule is that the full suite is heavy enough to freeze the machine, and
  nothing here changed code that a test suite would be verifying.

## Workflow

### 1. Detect the OS

```bash
case "$(uname -s 2>/dev/null)" in
  Darwin) echo "OS: macOS" ;;
  MINGW*|MSYS*|CYGWIN*) echo "OS: Windows (Git Bash)" ;;
  Linux) echo "OS: Linux — best effort, this fork is untested here" ;;
  *) echo "OS: could not detect (no uname) — assuming Windows PowerShell" ;;
esac
```

If it's PowerShell (no `uname`), say that the rest of this command assumes
Git Bash — the same shell docs/install.md's Windows steps use — and ask the
user to continue from a Git Bash terminal instead.

### 2. Safety gate — existing install

Check before touching anything:

```bash
# Is something already listening on the target port?
lsof -nP -iTCP:"${PASEO_INSTALL_PORT:-6767}" -sTCP:LISTEN 2>/dev/null \
  || netstat -ano 2>/dev/null | grep ":${PASEO_INSTALL_PORT:-6767} "

# Does ~/.paseo already exist?
[ -e "$HOME/.paseo" ] && echo "FOUND: $HOME/.paseo exists" || echo "clear: no ~/.paseo"
```

If **either** is found, print what was found (the process on the port if
`lsof`/`netstat` names one; `~/.paseo`'s presence) and stop. Ask the user to
pick one:

1. **Verify only** — run doctor-style checks against the existing home and
   port, make no daemon or config changes.
2. **Isolated instance** — use a separate `PASEO_HOME` and a non-default
   `PASEO_HOST=127.0.0.1:<port>` for a fresh install that never touches the
   existing one. Ask for the port and directory.
3. **Stop** — exit here so the user can deal with the existing install first.

Carry whichever `PASEO_HOME`/`PASEO_HOST` this choice implies into every later
step — export both and pass them explicitly to every command from here on. In
isolated mode, don't rely on `--port` alone: the CLI resolves an unspecified
host by reading `listen` from the config at `PASEO_HOME`, and falls back to
`127.0.0.1:6767` when that key isn't set — the exact way a read-only command
in isolated mode can silently reach a real, unrelated daemon. Set `PASEO_HOST`
for every command, and confirm `paseo daemon status` reports the isolated
home and port _before_ running anything else, plugin commands especially.

If both checks came back clear, continue with the defaults.

### 3. Prerequisites

Check each of these and print a status line right after:

- **Node**: `command -v node && node --version`. This repo pins `nodejs
22.20.0` in `.tool-versions`; require major version 22. If missing or the
  wrong major, stop and point to https://nodejs.org or `nvm install 22`
  — don't try to install Node yourself.
- **npm**: `command -v npm && npm --version` (ships with Node).
- **git**: `command -v git && git --version`. On macOS this is also the
  prerequisites table's "Xcode Command Line Tools" row — if `git` works,
  that box is checked; no separate Xcode check is needed. On Windows this is
  Git for Windows, which is also what provides Git Bash.
- **No compiler needed.** `node-pty`, the only native dependency, ships
  prebuilt binaries for macOS, Windows and Linux — don't check for Xcode's
  full toolchain or Visual Studio build tools; docs/install.md is explicit
  that neither is required.
- **Claude Code**: `command -v claude`. Required — the plugin needs it on the
  daemon's `PATH`. Sign-in is checked per pooled account in Step 8, not here.

### 4. Install and build

```bash
npm ci
npm run build:server
```

`build:server` builds the daemon and this checkout's own CLI
(`packages/cli/bin/paseo`), which is what the plugin's operator setup and
Step 6 onward need. Report `npm ci`'s package count and the build's exit
status.

Then ask: **"Also build the desktop app installer? It's slower (~2 minutes)
and produces a `.dmg`/`.exe` you'd still install by hand — skip it unless you
specifically want the GUI app right now."** Default to skipping. If yes:

```bash
npm run build:desktop -- --publish never
```

After **any** build step, check for the known trap:

```bash
git -C "$REPO_ROOT" diff --name-only -- package.json
```

If `package.json` changed, look at the diff. If the only change is an added
`"packageManager": "yarn@…"` line — Corepack's `yarn` shim leaking into the
build on this machine — revert it:

```bash
git -C "$REPO_ROOT" checkout -- package.json
```

If the diff has anything else in it, stop and show the user the diff instead
of reverting — that's not the known trap, and reverting it blind could
discard something they were working on.

### 5. The fork's CLI, not a stock one

```bash
export PATH="$REPO_ROOT/packages/cli/bin:$PATH"
which paseo
```

Confirm `which paseo` resolves inside `$REPO_ROOT/packages/cli/bin` — not
`~/.local/bin/paseo` or anywhere else. A `Paseo.app` install's CLI is stock
and rejects this fork's `config.json` keys. If another `paseo` was already
first on `PATH`, say so and remind the user this `export PATH` line only
applies to the current shell.

### 6. Start the daemon

Skip this step entirely if Step 2's answer was "Verify only." Otherwise, using
whatever `PASEO_HOME`/`PASEO_HOST` Step 2 settled on:

```bash
paseo daemon start
paseo daemon status
```

Confirm the status output shows the daemon running and `Claude  available
(daemon)`. If Claude shows `not found (daemon)`, stop and point at
docs/install.md's troubleshooting entry for it (the daemon's `PATH` doesn't
have `claude`) rather than continuing to plugin setup.

### 7. Configure the account pool

Ask the user for the pool topology — a real choice, not something to guess:

- How many worker accounts (plugin README's example uses one leader + two
  workers).
- The `CLAUDE_CONFIG_DIR` for the leader and each worker. Suggest
  `~/.claude-accounts/leader`, `~/.claude-accounts/worker-1`,
  `~/.claude-accounts/worker-2`, … as defaults.

Build the `pluginsEnabled` / `agents.providers` / `agentModelPolicy` block
from the plugin README's example, substituting the user's paths and worker
count. Read the current `config.json` at the resolved `PASEO_HOME` (creating
an empty `{}` in memory if the daemon hasn't written one yet), compute the
merge, and **show the diff**. Only write it after the user explicitly agrees
— never overwrite the file blind, even when it looks empty.

```bash
paseo reload
```

### 8. Sign each account in

For every `CLAUDE_CONFIG_DIR` from Step 7:

```bash
mkdir -p "<dir>"
ln -s ~/.claude/projects "<dir>/projects"
[ -f ~/.claude/CLAUDE.md ] && ln -s ~/.claude/CLAUDE.md "<dir>/CLAUDE.md"
```

Then print, verbatim, for the user to run themselves in their own terminal —
**do not run this command; it opens a browser and only they can complete it**:

```bash
CLAUDE_CONFIG_DIR="<dir>" claude /login
```

Wait for them to confirm they've done it (or say to skip and come back to it
later). Don't invent a local sign-in check here — Step 10's `paseo doctor
--full` is the one place that confirms login, and it does so by presence
only (a keychain item's existence, never its value), so there's exactly one
source of truth for "signed in" instead of two that could disagree.

### 9. Apply and install the plugin

```bash
paseo plugin install "$REPO_ROOT/$PLUGIN_DIR"
paseo plugin ls
```

Confirm the listing shows `claude-account-pool` as `running` with `ENABLED
yes`. If it shows `disabled`, `pluginsEnabled` didn't make it into the merge
in Step 7 — go back and check. If it shows `failed`, print
`paseo plugin logs claude-account-pool`.

### 10. Final verification

```bash
paseo doctor --full
```

This is the plugin README's own [verify it works](../../plugins/claude-account-pool/README.md#verify-it-works)
check. Look for:

- `✓ plugins  claude-account-pool: running`
- `✓ config  config.json is accepted by the running daemon`
- no `not logged in` line for any pooled account

Report every non-`✓` line doctor prints, with the fix command it names next
to each — doctor never mutates anything itself, so anything left failing here
is a real next step for the user, not something to force through.

## Report

Print a status table, one row per check in Steps 1–10 (pass/fail/skipped),
then:

- Which pooled accounts are confirmed signed in vs still need `claude /login`.
- Whether the desktop app installer was built, and if not, the two commands
  to build and install it later (Step 4's `build:desktop` line, then
  [docs/install.md#install-the-app](../../docs/install.md#install-the-app)).
- Next commands to paste:

```bash
paseo doctor --full
paseo ls -a -g
```

If anything is still failing, name it and the exact fix rather than declaring
the install done.
