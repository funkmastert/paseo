# Codex workers

A daemon-launched Codex child agent is a worker running under full guard coverage: the catastrophe gate, the native build gate, the device cap, and the physical-device install gate. Codex children have guards and are subject to caps; otherwise they work like any other agent.

## Binary discovery

The daemon finds Codex in this order:

1. PATH — any `codex` command available in the shell
2. ChatGPT bundle — `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (macOS) or `~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (user-installed, macOS)
3. Microsoft Store package `OpenAI.Codex_*` (Windows only)
4. `agents.providers.codex.command` in config — overrides all of the above

If none of these work, the error lists every path searched. Configure `agents.providers.codex.command` to specify a custom path.

## Platform notes

### macOS

The daemon probes `/Applications/ChatGPT.app` and `~/Applications/ChatGPT.app`. Both are checked.

### Windows

The Microsoft Store package `OpenAI.Codex_*` is the standard source. The daemon scans `%LOCALAPPDATA%\Packages` for packages starting with that prefix, sorted by name, and probes each candidate.

If the ChatGPT desktop app bundles Codex on Windows, that path will be added; this has not yet been verified on Windows builds.

### Known gaps

- Interactive shell input typed during a running Codex turn gets no PreToolUse hook event. The same gap Claude has: a tool call is visible when you press Enter, not as you type.

## Codex guard health

Before any worker child is routed to Codex, a self-test proves the guard works: one ordinary command must run, and one canary command must be denied. The test runs at daemon startup, daily, and whenever the Codex binary version changes.

If the guard health is `red` or `unknown`, Codex refs are unusable for children.

## Guarded mode: the daemon answers Codex's own approval requests

Codex children run in a `guarded` mode preset (`MODE_PRESETS.guarded`, internal — never offered in `CODEX_MODES`): `sandbox_mode: "workspace-write"` with `approval_policy: "on-request"`. A guarded child's `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` requests are answered in-process by the daemon instead of being surfaced to a person: `checkCatastrophe`, then the composed `deviceLaunchGate`, decide accept or decline before anything runs. No hook, no trust file, nothing written to `~/.codex`. Fails closed by construction — nothing runs until the daemon says yes.

**Why not hooks.** See "Guard hook: superseded" below — no hook delivery path survives unattended under `app-server`.

**Why not `danger-full-access` + `untrusted` (the first guarded-mode design).** Confirmed empirically against the real ChatGPT-bundled binary (0.160.0) on 2026-10-09:

- `approval_policy = "untrusted"` is rejected outright: `failed to load configuration: approval_policy = "untrusted" is no longer supported; remove this setting`. The top-level `codex --ask-for-approval`/`-a` flag's own `--help` confirms only `on-request` and `never` remain as plain string values (plus a `granular` object form).
- `sandbox_mode: "danger-full-access"` never triggers an approval request, with _any_ approval policy, `granular` included: nothing needs to escalate out of a sandbox that is already fully open, so there is nothing to ask about. Confirmed by running a guarded-shaped session and watching a `touch` outside the workspace succeed silently, with zero `permission_requested` events.

**What does work.** `sandbox_mode: "workspace-write"` with `approval_policy: "on-request"` — the same values Paseo's existing `auto` mode already uses for people. Proven end-to-end against the real binary: a command needing to escalate beyond the workspace root (deleting a file in `$HOME`, in this case) produces an `item/commandExecution/requestApproval` request _before_ the command runs; responding `accept` lets it run (the file was deleted); responding `decline` blocks it (the file still existed afterward, and the model reported "the escalated `rm` request was rejected"). The model has to recognize it needs to request escalation — a command it runs without flagging that just gets denied by the sandbox directly, with no approval request at all. Either way nothing catastrophic succeeds: a command the catastrophe gate would refuse either gets an explicit decline, or never executes because the sandbox denied it outright.

This changes what "guarded" means from the mode picker's `auto`: the _values_ are identical, but a guarded child's approval requests never reach a person — `handleCommandApprovalRequest`/`handleFileChangeApprovalRequest` detect the guarded mode and decide synchronously instead of creating a pending permission.

## Guard hook: superseded, no unattended delivery path (Codex CLI 0.160.0)

The original guard design used a PreToolUse hook. No hook delivery path runs unattended under `codex app-server`— this is why guarded mode (above) exists instead. Keep this list as the recheck for a future Codex release:

- **`-c` config overrides** (`codex app-server -c 'hooks.PreToolUse=[...]'`): the key is accepted — `--strict-config` does not reject it — but the hook never runs. It is silently skipped with no log line, no error, no block.
- **`~/.codex/hooks.json`** (the file-based path the terminal activity hook installer uses): same result. A `PreToolUse` entry added directly to the real file is silently skipped under non-interactive `codex exec`, identical to the `-c` case.
- **`--dangerously-bypass-hook-trust`**: this flag does run an untrusted hook (confirmed: the hook fired). But it exists only on `codex exec` — `codex app-server --dangerously-bypass-hook-trust` is a hard CLI error (`unexpected argument`). It also does not persist trust to `config.toml`; re-running without the flag goes back to silent-skip. There is no way to use it to bootstrap trust for later unattended `app-server` runs.

(A `trusted_hash` mechanism in `config.toml` and a `ManagedHooksRequirements`/MDM-style path also exist and were ruled out — see git history on this file for the full detail.)

If a later Codex release restores an `untrusted`-equivalent approval policy that asks even under `danger-full-access`, or adds an unattended-automation path for hook trust, re-run the checks above (and the guarded-mode proof) against the new version before changing this design.

## Limitations and future work

- Guarding `apply_patch` and MCP calls awaits follow-up work.
- Adding newly ranked models to pools automatically is deferred.
