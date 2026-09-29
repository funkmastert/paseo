---
description: Install Bozeo from source — prerequisites, build, the fork's daemon and CLI, the account pool plugin, Claude account sign-in, and a final doctor check
---

# Install Bozeo

## Purpose

Get a working Bozeo from this checkout: the fork's daemon running, the
`claude-account-pool` plugin installed, a Claude account signed in for each
pool entry, and `paseo doctor --full` green. Ask the user wherever a step is a
real choice, and never act for them where a browser sign-in is needed.

The machine may already run Paseo or Bozeo, with the user's live agents on it.
Every rule below exists so that this command never reaches that daemon.

## Source of truth

This command automates [docs/install.md](../../docs/install.md) and
[plugins/claude-account-pool/README.md](../../plugins/claude-account-pool/README.md#operator-setup).
Where they disagree with this file, they win. Re-read the section a step names
rather than trust this file's memory of it.

## Rules

### Your shell forgets everything between Bash calls

Each Bash tool call runs in a new shell. An `export`, a `PATH` change or a
function from one call is gone in the next; only the working directory
carries over. With the settings gone, the Paseo CLI falls back to the user's
real install:

- `--home ""` means `~/.paseo`.
- `reload`, `plugin`, `doctor` and `ls` without `--host` or `PASEO_HOST`
  connect to `localhost:6767`. They never read the port a new daemon's PID
  file records (`packages/cli/src/utils/client.ts:158-198`).
- `daemon status`, `stop` and `restart` pick their daemon from the home alone
  and ignore `PASEO_HOST`. `daemon status` has no `--host`
  (`packages/cli/src/commands/daemon/status.ts:469-489`).
- A bare `paseo` is whatever is first on the user's `PATH`, which can be
  upstream's CLI.

So:

- Step 4 writes the new instance's values once, to an env file, and prints its
  absolute path. Below, `<ENV_FILE>` stands for that path.
- **From Step 5 on, start every Bash call with `. "<ENV_FILE>"`**, with the
  real path in place of `<ENV_FILE>`, and run the step's commands in that same
  call.
- Call the CLI only as `bozeo_cli`, which the env file defines. It runs the
  built checkout's `packages/cli/bin/paseo`. Before any command except
  `daemon start` and `daemon status`, it checks that the daemon for
  `$BOZEO_HOME` is running on `$BOZEO_HOST`, and stops if it is not. It refuses
  `daemon stop`, `daemon restart` and `restart`.
- Pass `--home "$BOZEO_HOME"` and `--host "$BOZEO_HOST"` wherever a command
  takes them. The env file also exports `PASEO_HOME` and `PASEO_HOST` for the
  call, so a missed flag still reaches the right daemon.
- If you leave out the `.` line, `bozeo_cli` is `command not found` and nothing
  runs. Add the line and run the call again. Never fall back to a bare
  `paseo`.

`scripts/install-env.sh` implements all of this; the env file sources it.

### Modes

Step 2 looks for an existing install and the user picks a mode. Each step's
heading names the modes that run it. Skip a step whose heading does not name
the current mode.

| Mode              | Target                                           | Writes                                                                    |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Fresh install     | `${PASEO_HOME:-~/.paseo}` on port 6767           | Steps 4–10, each after consent                                            |
| Isolated instance | a new home on a new port, beside an existing one | Steps 4–10, each after consent; never the existing home, port or checkout |
| Verify only       | the existing install                             | Nothing in the existing install                                           |

Verify only runs Steps 1, 2, 3 and V, then the Report. It never runs Steps
4–10, even when a check fails.

### Every write needs a yes

Ask before each of these, name the absolute paths and the host involved, and
do nothing until the user agrees:

1. Step 4, one yes for Steps 4–7: the env file, a separate clone if Step 2
   requires one, `npm ci` and the build, and starting the daemon.
2. Step 8: adding the pool block to `config.json`.
3. Step 9: creating account directories and links.
4. Step 10: `plugin install`, which writes `plugins.claude-account-pool` into
   `config.json` and starts the plugin at once.

The env file, the pool patch and the build logs go in the checkout's `.dev/`,
which git ignores. They are this command's own working files.

### Daemons

- Never run `paseo daemon stop`, `paseo daemon restart` or `paseo restart`.
  `paseo reload` prints `Run: paseo daemon restart`; Step 8 says which of its
  lines to ignore. If anything else asks for a restart, stop and ask the user.
  If they want the instance this run started restarted, the only form you may
  run is
  `"$BOZEO_CLI" daemon restart --home "$BOZEO_HOME" --port "$BOZEO_PORT"`,
  after the `.` line.
- Never reload, install into, restart or stop a daemon this command did not
  start. Verify only reads status and runs doctor, nothing else.
- Never run `npm run dev`, `npm run dev:desktop` or the packaged app. They
  block a terminal or open a window. `daemon start` detaches, so it is fine.

### Secrets

- Never print, `cat`, `grep`, diff or read `config.json` into the
  conversation. It can hold provider API keys (`agents.providers.<id>.env`,
  `providers.openai.apiKey`) and the daemon password hash. The scripts this
  command runs print key paths and `daemon.listen`, never other values.
- Never print a credential file or its contents. A presence check prints a
  name and `SET`/`unset`, or an account and `signed in`/`not signed in`.
- Never run `claude /login`. It opens a browser. Print the command and wait for
  the user to run it.

### No test suite

Do not run the project's tests. This repo's full suite can freeze the
machine, and this command changes no code.

## Workflow

### 1. Detect the OS — all modes, writes nothing

```bash
case "$(uname -s 2>/dev/null)" in
  Darwin) echo "OS: macOS" ;;
  MINGW*|MSYS*|CYGWIN*) echo "OS: Windows (Git Bash). UNTESTED: nobody has run this install on Windows." ;;
  Linux) echo "OS: Linux. Untested for this fork." ;;
  *) echo "OS: unknown" ;;
esac
```

On Windows, tell the user plainly that this fork's install is untested on
Windows, and that Steps 6 and 9 and the sign-in have Windows notes you will
follow. Claude Code runs its Bash tool in Git Bash on Windows, the shell
docs/install.md's Windows build uses.

### 2. Look for an existing install — all modes, writes nothing

From the checkout root:

```bash
node scripts/install-preflight.mjs
```

It only reads. It checks `~/.paseo` and any `PASEO_HOME` your shell inherited
from the user's profile, each home's PID file and `daemon.listen`, whether
port 6767 and each home's port are in use and by what, whether any process
runs code from this checkout, and which `paseo` is on `PATH`. It prints
`PASEO_*` variable names, with values only for `PASEO_HOME`, `PASEO_HOST`,
`PASEO_LISTEN` and `PORT`.

Show the user its output, then offer the modes its `verdict` line names:

- `clear`: **Fresh install** into `${PASEO_HOME:-~/.paseo}` on 6767, or
  **Stop**.
- `EXISTING INSTALL OR BUSY PORT`: **Verify only**, **Isolated instance**, or
  **Stop**. Never offer Fresh install here.

Keep these lines for later steps: `protect` (Step 4 writes it into the env
file), `separate clone` (Step 4), and `cli` (Step V).

If the `env` lines show a `PASEO_*` variable other than `PASEO_HOME`, or
`PORT`, tell the user. The env file clears them for every later call, so the
new daemon does not inherit them.

### 3. Prerequisites — all modes, writes nothing

Check each and print a status line after it:

- **Node**: `node --version`. `.tool-versions` pins `nodejs 22.20.0`; require
  major 22. If it is missing or another major, stop and point to
  https://nodejs.org or `nvm install 22`. Don't install Node yourself.
- **npm**: `npm --version`.
- **git**: `git --version`. On macOS this also covers the Xcode Command Line
  Tools row of docs/install.md. On Windows it is Git for Windows, which
  provides Git Bash.
- **No compiler.** `node-pty`, the only native dependency, ships prebuilt
  binaries. Don't check for Xcode or the Visual Studio build tools.
- **Claude Code**: `command -v claude`. The plugin needs it on the daemon's
  `PATH`. Sign-in is checked per account in Step 11.

In an install mode, stop here if any check fails. In Verify only, report the
failures and go on to Step V.

### V. Verify the existing install — Verify only, writes nothing

Pick the CLI from Step 2's `cli` lines: this checkout's CLI if it says
`built`, else the `paseo` on `PATH` if it says `this fork's`. If neither,
stop: Verify only has no fork CLI to run, and building one is a write. Say so
in the Report.

Take the home and port from Step 2's `home` and `listens on` lines. Then, in
one call, with the three values substituted:

```bash
CLI="<absolute path to the CLI>"; H="<absolute existing home>"; P="<its port>"
: "${CLI:?}" "${H:?}" "${P:?}"
export PASEO_HOME="$(git rev-parse --show-toplevel)/.dev/verify-client"
if [ -f "$H/config.json" ]; then "$CLI" daemon status --home "$H"; else echo "skip daemon status: $H/config.json is missing"; fi
"$CLI" doctor --full --home "$H" --host "127.0.0.1:$P"
```

Every CLI command that connects to a daemon saves a client id to
`$PASEO_HOME/cli-client-id` if there is none
(`packages/cli/src/utils/client-id.ts`). The `export` sends it to this
checkout's ignored `.dev/`, not the existing home; `--home` and `--host` still
pick the install to check. `daemon status` writes a default `config.json`
when the home has none (`packages/server/src/server/persisted-config.ts:937-947`),
so it only runs against a home that has one. It also sets the home and
`config.json` to owner-only permissions, as the daemon does on every start.
`doctor` changes nothing. Report every line that is not `✓`, with the fix
doctor names, then go to the Report. Do not fix anything.

### 4. Choose the instance and write the env file — Fresh install, Isolated instance

**Isolated instance only:** ask the user for:

- a port. Suggest the first free one from 6790 up.
- an absolute directory for the new home, such as `$HOME/.paseo-bozeo`, with
  `$HOME` expanded. Never `~`.
- if Step 2's `separate clone` line says `REQUIRED`: an absolute directory
  for the clone, such as `$HOME/bozeo`. Building in place would replace
  `node_modules` and `packages/server/dist` under the daemon that runs from
  this checkout.

Re-check the answers. Run this again whenever an answer changes:

```bash
node scripts/install-preflight.mjs --check-port <port> --check-dir "<home>" --check-dir "<clone, if any>"
```

It refuses the default port, a port an existing home uses, a port in use, and
a directory that is an existing home, inside one, inside `~/.claude` or this
checkout, or not empty.

**Fresh install:** the home is `${PASEO_HOME:-$HOME/.paseo}`, expanded, and
the port is 6767. If Step 2's `separate clone` line says `REQUIRED`, tell the
user a process runs from this checkout, and ask them to stop it or to choose a
clone directory, re-checked as above.

Show the user the plan and ask for one yes for Steps 4–7:

- the env file, `<checkout>/.dev/install.env` (`.dev/` is ignored by git)
- the clone, if any
- `npm ci` and `npm run build:server` in the checkout that gets built
- a daemon started with that home and port

Then write the env file. Fill in the values: `BOZEO_REPO` is the clone if there
is one, else this checkout. `BOZEO_PROTECT` is Step 2's `protect` value, or
empty for a fresh install.

```bash
ENV_FILE="$(git rev-parse --show-toplevel)/.dev/install.env"
mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<'EOF'
BOZEO_SRC='<absolute path of this checkout>'
BOZEO_REPO='<absolute path of the checkout to build>'
BOZEO_HOME='<absolute path of the home>'
BOZEO_PORT='<port>'
BOZEO_PROTECT='<protect value from Step 2>'
. "$BOZEO_SRC/scripts/install-env.sh"
EOF
. "$ENV_FILE" && type bozeo_cli >/dev/null && echo "ENV_FILE=$ENV_FILE" && echo "cli $BOZEO_CLI  home $BOZEO_HOME  host $BOZEO_HOST"
```

If it prints `STOP:`, fix the value it names. Otherwise the printed
`ENV_FILE=` path is `<ENV_FILE>` for every later step.

### 5. Clone — only when Step 4 chose a clone directory

```bash
. "<ENV_FILE>"
git clone "$BOZEO_SRC" "$BOZEO_REPO" && git -C "$BOZEO_REPO" checkout --detach "$(git -C "$BOZEO_SRC" rev-parse HEAD)"
```

This builds the same commit this command came from. `git clone` from a local
path writes only inside `$BOZEO_REPO`.

### 6. Install and build — Fresh install, Isolated instance

The root `package.json` runs `lefthook install --force` on `npm ci`. If the
user's global git config sets `core.hooksPath`, lefthook installs into that
global directory and renames the user's own hooks to `.old`, which switches
them off in every repository. `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1` hide the global and system config from it, so the
hooks land in the built checkout's `.git/hooks`. `LEFTHOOK=0` does not prevent
the install.

On Windows, first run `git config --global --get core.hooksPath`. If it
prints a path, stop and ask: whether Git for Windows honours
`GIT_CONFIG_GLOBAL=/dev/null` is untested.

```bash
. "<ENV_FILE>"
(
  cd "$BOZEO_REPO" || exit 1
  git status --porcelain -- package.json > "$BOZEO_SRC/.dev/install-package-json.before"
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm ci > "$BOZEO_SRC/.dev/install-npm-ci.log" 2>&1
  echo "npm ci exit $?"
  npm run build:server > "$BOZEO_SRC/.dev/install-build.log" 2>&1
  echo "build:server exit $?"
)
```

On a non-zero exit, show the last 40 lines of that log and stop.

Then ask whether to also build the desktop app installer. It takes about two
minutes and produces a `.dmg` or `.exe` the user installs by hand; default to
skipping it. If yes:

```bash
. "<ENV_FILE>"
(cd "$BOZEO_REPO" && COREPACK_ENABLE_AUTO_PIN=0 npm run build:desktop -- --publish never > "$BOZEO_SRC/.dev/install-desktop.log" 2>&1; echo "build:desktop exit $?")
```

After the builds, check the known trap: with Corepack's `yarn` shim on
`PATH`, a build can add `"packageManager": "yarn@…"` to the root
`package.json`.

```bash
. "<ENV_FILE>"
echo "before: [$(cat "$BOZEO_SRC/.dev/install-package-json.before")]"
echo "after:  [$(git -C "$BOZEO_REPO" status --porcelain -- package.json)]"
git -C "$BOZEO_REPO" diff -U0 -- package.json | grep '^[-+][^-+]' || echo "package.json: unchanged"
```

Revert with `git -C "$BOZEO_REPO" checkout -- package.json` only when
`before` was empty and the only changed line is an added `"packageManager"`.
If `before` was not empty, the user had their own edits there: show them the
diff and leave it. For anything else, show the diff and stop.

### 7. Start the daemon — Fresh install, Isolated instance

**Isolated instance only**, first make the new home remember its port.
`daemon status` creates the home and the daemon's default `config.json`,
which says `127.0.0.1:6767`. Without this, a later
`paseo daemon start --home <home>` without `--port` would try the existing
daemon's port.

```bash
. "<ENV_FILE>"
bozeo_cli daemon status --home "$BOZEO_HOME" > /dev/null
node -e '
  const fs = require("fs");
  const [file, listen] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (config.daemon?.listen !== "127.0.0.1:6767") { console.log("STOP: this home is not new"); process.exit(1); }
  config.daemon.listen = listen;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log("daemon.listen set to " + listen);
' "$BOZEO_HOME/config.json" "$BOZEO_HOST"
```

Then, in both modes:

```bash
. "<ENV_FILE>"
bozeo_cli daemon start --home "$BOZEO_HOME" --port "$BOZEO_PORT"
bozeo_cli daemon status --home "$BOZEO_HOME"
bozeo_guard && echo "guard ok: $BOZEO_HOME is running on $BOZEO_HOST"
```

Look for `Local Daemon  running`, `Listen` equal to `$BOZEO_HOST`,
`Claude  available (daemon)`, and `guard ok`. If Claude shows
`not found (daemon)`, stop and point to docs/install.md's troubleshooting
entry for it. If `daemon start` fails, show its log path and stop; don't
retry on another home or port.

### 8. Configure the account pool — Fresh install, Isolated instance

Ask the user for the pool: how many worker accounts (the plugin README's
example has a leader and two workers), and a `CLAUDE_CONFIG_DIR` for each.
Suggest `$HOME/.claude-accounts/leader`, `$HOME/.claude-accounts/worker-1`,
and so on, and write them with `$HOME` expanded to its absolute value. The
daemon does not expand `~` in `config.json`, and `~` inside quotes is never
expanded by the shell. On Windows, write the paths with forward slashes, such
as `C:/Users/you/.claude-accounts/leader`: a single backslash starts an escape
in JSON. None of them may be `~/.claude` itself.

Write the pool block from the plugin README's
[step 2](../../plugins/claude-account-pool/README.md#2-configure-the-pool-and-the-policy)
to a patch file, with the user's paths and worker count: `pluginsEnabled`,
one `agents.providers` entry per account, and `agentModelPolicy`. Worker
priorities are 1, 2, 3, … and unique.

```bash
. "<ENV_FILE>"
cat > "$BOZEO_SRC/.dev/install-pool.json" <<'EOF'
{ …the pool block with absolute paths… }
EOF
node "$BOZEO_SRC/scripts/install-merge-config.mjs" --config "$BOZEO_HOME/config.json" --patch "$BOZEO_SRC/.dev/install-pool.json"
```

That dry run changes nothing. It prints each key path it would add, and a
`conflict` line for a key the file already sets to something else. It never
prints a value from `config.json`. It adds `agentModelPolicy` and each
provider entry whole or not at all, so a policy or provider the user already
has is never merged into or replaced.

- A `conflict` line, or an `invalid` line: stop. Show the user the paths and
  ask how to proceed. The merge writes nothing while any conflict remains.
- A `note` line: `pluginsEnabled` also starts plugins already recorded in the
  file. Plugins are unsandboxed code. Name them to the user.

Show the user the patch file and the dry run's output. Name the file it
writes, `$BOZEO_HOME/config.json` with the path expanded. On a yes:

```bash
. "<ENV_FILE>"
node "$BOZEO_SRC/scripts/install-merge-config.mjs" --config "$BOZEO_HOME/config.json" --patch "$BOZEO_SRC/.dev/install-pool.json" --write
bozeo_cli reload --host "$BOZEO_HOST"
```

`--write` copies the file to `config.json.bak-<timestamp>` first, then
replaces it atomically, keeping its permissions.

`reload` prints `Warning: These changes require a daemon restart:`, a list of
paths such as `agentModelPolicy.roles`, and `Run: paseo daemon restart`.
**Ignore every listed path that starts with `agentModelPolicy.` or
`plugins.`.** The list compares the file with the one the daemon started from,
and both are already live (plugin README,
[step 4](../../plugins/claude-account-pool/README.md#4-apply-the-config)). Do
not restart. If the list names any other path, stop and ask the user.

### 9. Account directories and sign-in — Fresh install, Isolated instance

For each `CLAUDE_CONFIG_DIR`, this step creates the directory, links its
`projects/` to `~/.claude/projects` so a session can move between accounts,
and links `CLAUDE.md` to `~/.claude/CLAUDE.md` if the user has one. First look,
changing nothing:

```bash
. "<ENV_FILE>"
for d in "<abs dir 1>" "<abs dir 2>"; do
  if [ -e "$d" ]; then echo "$d: exists, $(ls -A "$d" | wc -l | tr -d ' ') entries"; else echo "$d: new"; fi
  [ -L "$d/projects" ] && echo "  projects: already linked -> $(readlink "$d/projects")"
done
[ -d "$HOME/.claude/projects" ] && echo "~/.claude/projects: exists" || echo "~/.claude/projects: missing, will be created"
[ -f "$HOME/.claude/CLAUDE.md" ] && echo "~/.claude/CLAUDE.md: exists" || echo "~/.claude/CLAUDE.md: none"
```

If a directory exists with entries, ask before using it. Get a yes, then:

```bash
. "<ENV_FILE>"
mkdir -p "$HOME/.claude/projects"
for d in "<abs dir 1>" "<abs dir 2>"; do
  case "$d" in /*|[A-Za-z]:/*) ;; *) echo "STOP: $d is not absolute"; continue ;; esac
  [ "$d" = "$HOME/.claude" ] && { echo "STOP: $d is ~/.claude itself"; continue; }
  mkdir -p "$d"
  for name in projects CLAUDE.md; do
    target="$HOME/.claude/$name"
    [ -e "$target" ] || continue
    if [ -L "$d/$name" ]; then echo "$d/$name: already linked -> $(readlink "$d/$name")"
    elif [ -e "$d/$name" ]; then echo "STOP: $d/$name exists and is not a link; left alone"
    else MSYS=winsymlinks:nativestrict ln -s "$target" "$d/$name"; fi
    [ -L "$d/$name" ] && echo "$d/$name: link ok" || echo "FAIL: $d/$name is not a link"
  done
done
```

Running it twice changes nothing: an existing link is left as it is, so it
never creates `projects/projects`. `MSYS=winsymlinks:nativestrict` makes Git
Bash on Windows fail rather than copy `~/.claude/projects`, which can be
many GB; elsewhere it is ignored. A `FAIL` line means the link did not
happen: stop and show the user. Without a global `~/.claude/CLAUDE.md` there
is nothing to link, and Step 11 explains doctor's line about it.

Then print, for the user to run in their own terminal, one line per directory.
**Do not run it.** It opens a browser.

```bash
CLAUDE_CONFIG_DIR="<abs dir>" claude /login
```

On Windows, give the PowerShell form too, also untested:

```powershell
$env:CLAUDE_CONFIG_DIR = "<abs dir>"; claude /login; Remove-Item Env:CLAUDE_CONFIG_DIR
```

Each directory signs in to a different Claude account. Wait for the user to
say they are done, or to skip for now. Step 11 checks sign-in.

### 10. Install the plugin — Fresh install, Isolated instance

```bash
. "<ENV_FILE>"
bozeo_cli plugin ls --host "$BOZEO_HOST"
```

If `claude-account-pool` is already listed, skip the install: `plugin install`
refuses an id that is already configured. Otherwise tell the user this writes
`plugins.claude-account-pool` into `$BOZEO_HOME/config.json` (expanded) and
starts the plugin in the daemon on `$BOZEO_HOST` at once, and that plugins run
unsandboxed. On a yes:

```bash
. "<ENV_FILE>"
bozeo_cli plugin install "$BOZEO_REPO/plugins/claude-account-pool" --host "$BOZEO_HOST"
bozeo_cli plugin ls --host "$BOZEO_HOST"
```

Look for `claude-account-pool` with STATUS `running` and ENABLED `yes`.
`disabled` means `pluginsEnabled` did not make it into Step 8's merge.
`failed`: run `bozeo_cli plugin logs claude-account-pool --host "$BOZEO_HOST"`
after the `.` line.

### 11. Final check — Fresh install, Isolated instance

```bash
. "<ENV_FILE>"
bozeo_cli doctor --full --home "$BOZEO_HOME" --host "$BOZEO_HOST"
```

This is the plugin README's
[verify](../../plugins/claude-account-pool/README.md#verify-it-works) check.
Look for:

- `✓ plugins  claude-account-pool: running`
- `✓ config  config.json is accepted by the running daemon`
- no `not logged in` line for a pooled account

Report every line that is not `✓`, with the fix doctor names. Doctor changes
nothing, so what fails here is the user's next step. One is expected: without
a global `~/.claude/CLAUDE.md`, doctor fails `no CLAUDE.md` for `~/.claude`
and for each pooled account. Creating that file is the user's choice; say so
rather than creating it.

## Report

A table with one row per step (pass, fail, skipped, and why), then:

- The mode, home, port and built checkout.
- Which pooled accounts are signed in, and which still need `claude /login`.
- Whether the desktop installer was built. If not, the command to build it
  later (Step 6) and
  [docs/install.md#install-the-app](../../docs/install.md#install-the-app).
- Commands the user can paste into their own terminal. Use the absolute CLI
  path and explicit flags, never a bare `paseo`, which may be another CLI or
  reach another daemon:

```bash
"<BOZEO_CLI>" daemon status --home "<BOZEO_HOME>"
"<BOZEO_CLI>" doctor --full --home "<BOZEO_HOME>" --host "<BOZEO_HOST>"
"<BOZEO_CLI>" ls -a -g --host "<BOZEO_HOST>"
```

- Isolated instance: to start it again later, run
  `"<BOZEO_CLI>" daemon start --home "<BOZEO_HOME>" --port <BOZEO_PORT>`. Every
  other command needs `--host "<BOZEO_HOST>"`; without it the CLI reaches the
  daemon on 6767.
- Fresh install: the daemon runs from the CLI on 6767 with
  `${PASEO_HOME:-~/.paseo}`. A desktop app installed later uses the same home
  and port, so it connects to this daemon or stops it (docs/install.md,
  "Before you start").

If anything still fails, name it and its fix. Don't call the install done.
