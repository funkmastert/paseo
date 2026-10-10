# Install

This page builds this fork's desktop app from source on macOS or Windows and gets it running. Setting up the Claude account pool is the plugin's own doc, linked below. Or run `/install` in Claude Code to be walked through it.

The fork has no releases yet. If its [Releases page](https://github.com/funkmastert/paseo/releases) lists one when you read this, download that instead: the release page has the install steps. [fork-releases.md](fork-releases.md) covers how releases are made.

The macOS build steps below were run on an Apple Silicon Mac. The Windows steps come from the build config and from the job upstream uses to build its Windows release. Nobody has run them for this fork on Windows hardware yet, and this page marks the Windows behaviour that is unknown.

## Before you start

- **Quit upstream Paseo.** Bozeo and Paseo both keep their state in `~/.paseo` and serve on port 6767. Whichever starts second either stops the first one's daemon or connects to it.
- **Back up `~/.paseo`** if upstream Paseo has used it. This fork is based on Paseo 0.8.0, and nobody has tested it on a directory that a newer upstream release wrote.
- **An existing `~/.paseo` blocks a fresh install.** `scripts/install-preflight.mjs` reports `EXISTING INSTALL OR BUSY PORT` whenever the directory is there, even with no daemon running, and the `/install` command then offers only **Verify only** or **Isolated instance** — never a fresh install over it. To let Bozeo own the default home and port, see [Replace an existing install](#replace-an-existing-install).

## Replace an existing install

An isolated instance is the safe default and needs nothing here. These steps are for
giving Bozeo the default home and port that an existing Paseo or Bozeo install holds.

Quit the app and stop the daemon first, then move the home aside rather than deleting it:

```bash
paseo daemon status                     # confirm nothing is running for ~/.paseo
mv ~/.paseo ~/.paseo.pre-bozeo-$(date +%Y%m%d)
```

`~/.paseo` holds `daemon-keypair.json` and `server-id`, which are the daemon's identity:
a new home generates new ones, so every paired phone has to pair again. It also holds
`agents/`, `loops/`, `schedules/` and `worktrees/`. Moving the directory keeps all of it.

Two things are worth copying into the new home once `/install` has created it, because
nothing else recreates them:

```bash
cp -R ~/.paseo.pre-bozeo-<date>/agent-context ~/.paseo/agent-context   # if you use it
cp -R ~/.paseo.pre-bozeo-<date>/models ~/.paseo/models                 # saves a ~1 GB re-download
```

Re-run `node scripts/install-preflight.mjs` after the move. It reports `clear`, and
`/install` then offers a fresh install.

## Prerequisites

|             | macOS                                                           | Windows                                  |
| ----------- | --------------------------------------------------------------- | ---------------------------------------- |
| System      | macOS 13 or later                                               | Windows 10 or later, x64 or Arm          |
| Git         | Xcode Command Line Tools (`xcode-select --install`)             | Git for Windows, which includes Git Bash |
| Node.js     | 22                                                              | 22                                       |
| Claude Code | Installed, signed in, and `claude` on your `PATH`               | Same                                     |
| Disk        | About 4 GB for the checkout and build, 0.6 GB more on first run | Same                                     |

- **Node.js 22** is what CI uses, and `.tool-versions` pins 22.20.0. These steps were run on 22.16.0 with npm 10.9.2, which ships with it. Other major versions are untested.
- **No compiler.** The only native dependency, `node-pty`, ships prebuilt binaries for macOS, Windows and Linux on x64 and arm64, so you do not need Xcode or the Visual Studio build tools.
- **Claude Code** is the one agent CLI the account pool needs. Codex, Copilot, OpenCode and Pi are optional.

## Build

Run these in Terminal on macOS and in Git Bash on Windows. Git Bash is the shell that upstream's Windows release job runs this build in.

```bash
git clone --branch multi-account-orchestrator https://github.com/funkmastert/paseo.git
cd paseo
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm ci
npm run build:desktop -- --publish never \
  -c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false
```

- `--branch multi-account-orchestrator` gets this fork. The default branch, `main`, is an unmodified copy of upstream.
- `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` protects your own git hooks. `npm ci` runs the repo's `prepare` script, `lefthook install --force`. If your global or system git config sets `core.hooksPath`, lefthook installs its hooks in that shared directory and renames yours to `.old`, which turns them off in every repository. With the two variables set, lefthook sees neither config and installs into the checkout's `.git/hooks`. `LEFTHOOK=0` does not stop the install. On Windows, whether Git for Windows honours `/dev/null` here is unknown: if `git config --get core.hooksPath` prints a path, copy that directory somewhere safe before `npm ci`.
- `--publish never` builds without uploading anything.
- `-c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false` are required on macOS. `electron-builder.yml` sets `notarize: true` and `hardenedRuntime: true` for the signed release job; without these three overrides a local build fails, because notarization needs an Apple Developer ID you do not have. They are the same overrides [desktop-release.yml](../.github/workflows/desktop-release.yml) applies when no Apple signing secrets are set. On Windows they are accepted and ignored.

The app checks this fork's GitHub releases for updates (`publish` in `packages/desktop/electron-builder.yml`).

On a 16-core Apple Silicon Mac with warm npm and Metro caches, `npm ci` took 28 seconds and `npm run build:desktop` took under 2 minutes. A first build on a new machine also downloads every dependency. Build time on Windows is unknown.

## Install the app

The build writes to `packages/desktop/release/`. Both the file names and the app inside say Bozeo.

| Platform | File                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| macOS    | `Bozeo-<version>-arm64.dmg` on Apple Silicon, plus a `.zip` of the same app                 |
| Windows  | `Bozeo-Setup-<version>-x64.exe` and `Bozeo-Setup-<version>-arm64.exe`, plus `.zip` archives |

**macOS.** Open the `.dmg` and drag Bozeo to Applications. The three `-c.mac.*` overrides from [Build](#build) sign the app ad hoc and skip notarization, because you have no Apple Developer ID. Gatekeeper only checks files that arrived with a quarantine flag, and a file you built yourself has none, so the app opens without a prompt.

**Windows.** Run the installer that matches your PC: `x64` for Intel and AMD, `arm64` for Arm. It lets you choose where to install the app. The installer is unsigned. Unknown: whether SmartScreen warns about an installer you built on the same machine. If it does, [unsigned-windows.md](../.github/release-notes/unsigned-windows.md) has the steps.

## First run

1. Open Bozeo. It starts its daemon on `127.0.0.1:6767` and keeps its state in `~/.paseo` (`%USERPROFILE%\.paseo` on Windows).
2. The first start downloads about 600 MB of local speech models into `~/.paseo/models/local-speech`, in the background.
3. Claude shows up as a provider once the daemon can find `claude`. On macOS the app reads `PATH` from your login shell. On Windows it uses the `PATH` it was started with, so start it after Claude Code is installed.
4. Install the CLI from **Settings → Integrations → Command line → Install**. This is the fork's CLI; upstream's `paseo` fails to load this fork's `config.json`. On macOS it links `~/.local/bin/paseo`, replacing whatever was there, and adds `~/.local/bin` to your shell's rc file. On Windows it writes `%USERPROFILE%\.local\bin\paseo.cmd` and does not touch `PATH`, so add that folder to your user `PATH` yourself.

To reach it from a phone, open **Settings**, choose your host, and use **Pair device**. The App Store and Play Store apps are built from upstream: they do not have this fork's orchestration panel, and nobody has tested them against this fork's daemon. Building the Android app from this fork is covered in [android.md](android.md).

## Set up the account pool

Follow the plugin's [operator setup](../plugins/claude-account-pool/README.md#operator-setup) from step 2, then its [verify](../plugins/claude-account-pool/README.md#verify-it-works) section. Skip step 1: the desktop app already runs this fork's daemon on `127.0.0.1:6767` with `~/.paseo`, and the CLI from **Settings → Integrations** is this fork's CLI.

The **Enable plugins** switch in **Settings → Plugins** sets the same `pluginsEnabled` key that step 2 puts in `config.json`, and that page can install the plugin from its directory in place of step 5's command.

On Windows, which the plugin README has not been tested on:

- **Sign in from PowerShell.** Step 3's command is POSIX shell. The PowerShell form, also untested:

  ```powershell
  $env:CLAUDE_CONFIG_DIR = "$HOME\.claude-accounts\worker-1"; claude auth login --email <worker-address>; Remove-Item Env:CLAUDE_CONFIG_DIR
  ```

- **Check the links.** Step 3 links each account's `projects/` and `CLAUDE.md` to `~/.claude` with `ln -s`. Unknown: whether Git Bash's `ln -s` makes a link or a copy on your machine. `paseo doctor` reports an account whose `projects/` is not a link to `~/.claude/projects`.
- **Escape paths in JSON.** Write `CLAUDE_CONFIG_DIR` paths in `config.json` with forward slashes or doubled backslashes, because a single backslash starts an escape sequence in JSON.

To run the daemon without the desktop app, on a server for example, follow step 1 of the same operator setup.

## Verify it worked

```bash
paseo daemon status
```

The daemon is running and can find Claude. Your IDs, paths and hostname differ; these are the lines that matter:

```text
Local Daemon      running
Connected Daemon  reachable
Listen            127.0.0.1:6767
Daemon Version    0.8.0

Providers
  Claude          available (daemon)
```

The plugin README's [verify](../plugins/claude-account-pool/README.md#verify-it-works) section checks the pool itself.

## Troubleshooting

The plugin README's [troubleshooting](../plugins/claude-account-pool/README.md#troubleshooting) covers the pool: plugins disabled or failed, signed-out accounts, a malformed pool config. These are the app and daemon failures.

**The app is called Paseo, not Bozeo.** You built `main`. Run `git checkout multi-account-orchestrator` and the `npm ci` line from [Build](#build), then build again.

**Paseo and Bozeo keep stopping each other's daemon.** They share `~/.paseo` and port 6767. Quit one of them.

**`paseo daemon start` prints `Daemon failed to start in background (exit code 1)`.** Run `paseo daemon status`. If it shows a daemon running for that home, that daemon holds the home's lock: use it, or stop it with `paseo daemon stop`.

**`paseo daemon status` shows `Claude  not found (daemon)`.** The daemon cannot find `claude` on its `PATH`. On macOS, check that `command -v claude` finds it in a new terminal, then quit and reopen the app. On Windows, check `where claude`, then quit the app completely and start it again.

**Windows: `paseo` is not recognized.** Add `%USERPROFILE%\.local\bin` to your user `PATH` and open a new terminal.

**After a build, `git status` shows `package.json` modified with a `packageManager` line.** The build added it on a machine where Corepack's `yarn` shim is on `PATH`. Run `git checkout package.json` so your next `git pull` does not conflict.

**The package step fails.** Run the app from source instead: `npm run dev:desktop` on macOS, or `npm run dev:win:desktop` on Windows. It keeps its state inside the checkout and runs its daemon on its own port, so it can run while the installed app is open.

**The build fails at notarization, or asks for an Apple Developer ID.** `packages/desktop/electron-builder.yml` sets `notarize: true` and `hardenedRuntime: true` for the signed release job. A local build has to turn both off and sign ad hoc; the [Build](#build) command's three `-c.mac.*` overrides do that. Without them the build gets as far as packaging and then fails.

**The phone cannot reach the daemon after a fresh install.** A new home is written with `daemon.relay.enabled: false` and `daemon.listen: 127.0.0.1:6767`. Loopback accepts nothing from the network, so neither the relay nor a direct connection works until you change one of them. Either enable the relay, or set `daemon.listen` to the machine's Tailscale or LAN address — see [Connectivity](https://paseo.sh/docs/connectivity). Both need a daemon restart.

**`paseo doctor` warns `no skills/` for every pooled account.** The account directories were created before the [plugin setup](../plugins/claude-account-pool/README.md#3-sign-each-account-in) linked `skills/`. Doctor prints the `ln -s` for each one. Without the link, each account sees a different skill set, so the same prompt behaves differently depending on where the pool placed it.

**`paseo doctor` warns `Running daemon is older than Paseo.app`.** It compares the running daemon against the newest app bundle it can find, so an old upstream `Paseo.app` left in `/Applications` triggers it even when the daemon is newer. Remove the stale app, or relaunch the one you mean to use.

**Node is 22 in one terminal and older in another.** `scripts/install-env.sh` stops with `STOP: node is not on PATH`, or the build fails on syntax, when the shell running it resolves an older Node. A version manager such as nvm only applies to shells that load it, and non-interactive shells often do not. Run `node --version` in the exact shell you are building from, and load the version manager there first.

**`git commit` fails in the lint or format hook with `ERR_UNKNOWN_FILE_EXTENSION`.** The same cause. Lefthook's `pre-commit` runs `oxlint` and `oxfmt` in its own non-interactive shell, which inherits `PATH` from the `git` process rather than your profile, so an older default Node runs the binaries and cannot load them. Commit from a shell whose `node --version` is already 22.

**Linux.** The build config also has AppImage, deb, rpm and tar.gz targets. This page does not cover them.
