# Catastrophe gate

Agents get as much power as they can use. The catastrophe gate takes away exactly two things: rewriting or deleting `main` on a remote, and wiping a disk, a volume or a home directory. Everything else runs. A false positive costs more than a miss here, because a gate that blocks ordinary work teaches agents to route around it.

The rules are pure code in `packages/server/src/server/agent/catastrophe-gate.ts`, over the shell walker in `agent/shell-commands.ts`. No model, no network call, no threshold. The only I/O is one local git lookup, run for a force push whose target depends on the repository, or for `--prune` alongside `--all`/`--branches`/a pattern refspec that can land on `main`: `git rev-parse --abbrev-ref HEAD` for a push that names no ref or names `HEAD`, and `git rev-parse --verify` the matching local ref for a push that carries every branch. `--mirror` needs no lookup — it blocks outright (below).

## What it blocks

| Rule                    | Blocks                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `force-push-main`       | `git push` with `--force`, `-f`, `--force-with-lease` or `--force-if-includes`, or a `+` refspec, whose destination is `main` (`main`, `HEAD:main`, `refs/heads/main`)                                                           |
|                         | the same with no refspec, or with `HEAD`, while `main` is checked out where the push runs (`git -C` and `cd` are followed)                                                                                                       |
|                         | `--mirror`, always — it force-updates or deletes the remote's `main` in every local state, so it blocks outright with no lookup                                                                                                  |
|                         | `--all` or `--branches` with force; `:` with force; a forced pattern refspec that lands on `main` (`refs/heads/*:refs/heads/*`, `refs/*:refs/*`) — from any branch, when the repository has the branch it would push onto `main` |
| `delete-main`           | `git push --delete main`, `-d main`, `:main`                                                                                                                                                                                     |
|                         | `--prune` with `--all`, `--branches`, or a pattern refspec that can land on `main`, forced or not, when the repository has no local `main` to keep it there                                                                      |
| `rm-disk-root`          | recursive `rm` of `/`, `/*`, the home directory (`~`, `$HOME`, `~/*`), `/Users`, `/Users/<name>`, `/System`, `/Volumes`, `/Volumes/<name>`, `/System/Volumes/Data`; on Windows, a drive root (`/c`, `C:/`) too                   |
| `find-delete-disk-root` | `find <one of those roots> -delete` or `-exec rm`, with no narrowing test                                                                                                                                                        |
| `diskutil-erase`        | `diskutil eraseDisk`, `eraseVolume`, `zeroDisk`, `randomDisk`, `secureErase`, `reformat`, `partitionDisk`, `apfs deleteContainer`, `apfs eraseVolume`                                                                            |
| `raw-disk-write`        | `dd of=/dev/disk*` or `/dev/rdisk*` (and Linux block devices), and a `>` redirection onto one                                                                                                                                    |
| `format-disk`           | `mkfs*` and `newfs*` over a `/dev` disk device                                                                                                                                                                                   |

Only `main`. `master` and every other branch are ordinary. Path matching is case-insensitive, because APFS is.

On Windows, Claude Code runs Bash through Git Bash, and the gate reads paths the way Git Bash does: `C:\Users\x`, `C:/Users/x` and `/c/Users/x` are one place, `\` separates, and `$USERPROFILE` is the home directory. So `/c/Users/<name>` is a home directory and `/c` is a disk. The daemon's own `C:\…` cwd and home are converted the same way, and git lookups run in the Windows path.

The walker reads the command the way a shell would: it splits `&&`, `||`, `;`, `|` and newlines, runs `$(…)`, backticks, `bash -c`, `sh -c`, `eval`, heredocs and `echo … | sh` as the commands they are, peels `sudo`, `env`, `xargs`, `nice`, `time`, `nohup`, `timeout` and `command`, and tracks `cd` and plain assignments within the line. `cd / && rm -rf *` is `rm -rf /*`. Words inside quotes are arguments, so `echo "git push -f origin main"` runs nothing and passes.

## What it lets through on purpose

- **Anything it cannot resolve.** An unknown variable (`rm -rf "$DIR"`), a command's output (`rm -rf $(pwd)`), `cd -`, a script file (`bash wipe.sh`). This is the more-power default; the list of known gaps is below.
- **Subdirectories.** `rm -rf ~/code/tmp`, `find ~/code/tmp -delete`, anything inside a repo.
- **Filtered finds.** Any non-negated narrowing test (`-name`, `-path`, `-mtime`, `-size`, `-empty`, …) makes a find a cleanup. `find ~ -name .DS_Store -delete` passes; `find ~ -type f -delete` does not.
- **What rm refuses anyway.** An operand ending in `.` or `..` deletes nothing, so `rm -rf ..` passes.
- **RAM disks and images.** `diskutil eraseVolume HFS+ RAMDisk $(hdiutil attach -nomount ram://…)` has an unresolvable device and passes; `mkfs.ext4 disk.img` formats a file.
- **Dry runs.** `git push -n --force origin main` pushes nothing.
- **Pushes of every branch that leave main alone.** `git push --all` and `git push origin :` without force only fast-forward `main`, and without `--prune` delete nothing. A forced `--all` or `--branches` from a repository with no local `main` has no `main` to force-update onto the remote. (`--mirror` is the one exception: it always blocks, since it implies both force and prune — see the rules table.)

## Where it runs

- **Claude's `PreToolUse` hook**, one matcher each for `Bash` and `Monitor`, next to the device gate in `providers/claude/agent.ts`. It fires under `bypassPermissions` and inside subagents; see [gating a tool call](providers.md#gating-a-tool-call) for why a hook and never `canUseTool`. It uses the `cwd` the hook reports, which follows the Bash tool's shell.
- **A guarded-mode Codex child's command-approval request.** Codex has no hook, so a daemon-launched child runs in a `guarded` mode preset (`workspace-write` sandbox, `on-request` approvals) whose `item/commandExecution/requestApproval` requests the daemon answers itself — `codex-guard.ts`'s `decideCodexGuardedCommand`, called from `handleCommandApprovalRequest` in `providers/codex-app-server-agent.ts`. `apply_patch` requests are approved outright, matching Claude: this gate covers shell commands only. Unlike the hook below, **this path fails closed**: any error declines, because a guarded child has no other layer (docs/codex-workers.md). Only guarded mode is covered — Tyler's own Codex sessions, and any other Codex mode, are not.
- **`send_terminal_keys`**, in `agent/tools/paseo-tools.ts`. `TypedTerminalLines` (`agent/typed-terminal-lines.ts`) rebuilds each line the agent submits from the keys it sends: Enter submits, Ctrl-C and Ctrl-U clear, a heredoc typed line by line is checked whole when its delimiter (or Ctrl-D) arrives. A line edited by a key only the shell understands (Tab, an arrow, history) is dropped rather than guessed at. A refused call sends nothing.

Outside guarded-mode Codex, only Claude is gated. Another provider would call `checkCatastrophe` from its own interception point, listed per provider in [device-leases.md](device-leases.md#enforcement) and described in [gating a tool call](providers.md#gating-a-tool-call).

Any error inside Claude's hook allows the command, and the hook's own 10-second timeout does too. The guarded-mode Codex path is the one exception: it declines on error instead (above).

## What the agent sees

```
Blocked by the catastrophe gate (rule: force-push-main): it force-updates main on the remote (refspec main).
Command: git push --force origin main
This block is final. Do not work around it: not with another tool, a script file, a heredoc, bash -c, a terminal, another agent, or a different spelling of the same command.
If this action is really intended, stop and ask Tyler to run it himself.
```

Every block logs one warn line with `rule`, `agentId`, `subagentId` (inside a subagent), `cwd` and `command` capped at 500 characters:

```sh
grep -E '"msg":"Catastrophe gate blocked (a command|terminal input)"' "$PASEO_HOME/daemon.log"
```

## Turning it off

`agents.catastropheGate.enabled` in `config.json`. Absent means on. It is read on every call, so `false` followed by a config reload reaches running agents without restarting them. The daemon logs a `"Monitor mode"` line with `monitor: "catastrophe-gate"` at boot and whenever it changes.

The key needs a daemon built from adc4e7001 (the gate's merge) or later. An older daemon rejects a `config.json` that has it: new connections, config reloads and the next boot all fail. Write it only once the running daemon has the gate, and delete it before you roll back to `/Applications/Bozeo.prev.app` or any other build older than adc4e7001.

## Known gaps

- **Values it cannot see:** unknown environment variables, command substitution output, `xargs` input, loop variables, `cd -` and `popd`, `sudo -D` and `env -C`.
- **Code in other languages or files:** a script file, `python -c`, `node -e`, a Makefile or npm script, a git alias (`git pf`).
- **Push config:** `remote.<name>.push` refspecs, `push.default=upstream` mapping a feature branch onto main, and `push.default=matching` with force.
- **The remote's side:** the gate decides from local refs, never the remote's. `--mirror` and `--prune` with `--all`/`--branches`/a wildcard refspec are covered (rules table above); a `--prune`d push whose destination comes from `push.default` or `remote.<name>.push` instead of an explicit `--all`/`--branches`/wildcard refspec is not checked — see the push config gap above.
- **Other ways to move a ref:** `gh api` or `curl` against the forge's refs API, GitHub MCP tools, `tea`.
- **Other routes to a shell:** `paseo terminal send-keys` arrives as terminal input over the WebSocket, the same path as a person typing in the app, so it is not gated. `start_workspace_script` runs scripts from `paseo.json`, which an agent can edit. Terminal lines are checked from the terminal's starting cwd; a `cd` typed on an earlier line is not carried over.
- **Other providers:** OpenCode, Copilot and the ACP providers, Pi and OMP. Codex is gated only in guarded mode (above) — a Codex child in any other mode, including Tyler's own sessions, is ungated.
- **Parser limits:** globs other than a trailing `*` (`/U*`), brace expansion, `find` expressions whose `-o` changes what `-delete` applies to, `case` patterns inside a subshell.
- **Windows:** PowerShell and `cmd` syntax (the gate reads POSIX shell, so a PowerShell terminal driven through `send_terminal_keys` is read as bash), and a program spelled with `.exe` (`rm.exe`, `git.exe`).
- **Known false positives, all rare:**
  - A repo migration that mirrors history onto a fresh, empty remote: `git push --mirror <remote>` now always blocks, and `git push -f --all --prune <remote>` blocks too when the repository has no local `main`. The gate cannot see that the remote is empty and has nothing to lose. Push branches and tags explicitly instead — `git push --all <remote>` then `git push --tags <remote>` need no force or prune against an empty remote and pass — or turn the gate off for the one command (`agents.catastropheGate.enabled: false`, needs a daemon built from adc4e7001 or later; see "Turning it off").
  - A catastrophic line typed as text into a non-shell program through `send_terminal_keys`.
  - Setting up a RAM disk in two calls: `hdiutil attach -nomount ram://…`, then `diskutil eraseVolume`/`newfs_hfs` on the printed `/dev/diskN` in a separate command. The single-line form (`diskutil eraseVolume HFS+ RAMDisk $(hdiutil attach -nomount ram://…)`) passes; telling the two apart needs the disk's actual type, which the gate does not look up.
  - `rm -rf /Users/Shared`, a sibling directory such as `/Users/<home>.old`, or a mounted DMG under `/Volumes/<name>`. `rm-disk-root` protects any single path segment directly under `/Users` or `/Volumes`, not only real home directories and real volumes.

## Changing the rules

Every rule change starts in the tables in `catastrophe-gate.test.ts`: a case that must block and, more important, the ordinary commands next to it that must never block. Add allow cases generously. A new rule belongs here only if it is as narrow as these: one command shape, one catastrophic target, no judgment.
