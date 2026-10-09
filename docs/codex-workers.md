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

## Guard hook: blocked, no unattended delivery path (Codex CLI 0.160.0)

No hook delivery path runs a PreToolUse guard hook unattended under `codex app-server`. Confirmed empirically against the real ChatGPT-bundled binary (0.160.0) on 2026-10-09:

- **`-c` config overrides** (`codex app-server -c 'hooks.PreToolUse=[...]'`): the key is accepted — `--strict-config` does not reject it — but the hook never runs. It is silently skipped with no log line, no error, no block.
- **`~/.codex/hooks.json`** (the file-based path the terminal activity hook installer uses): same result. A `PreToolUse` entry added directly to the real file is silently skipped under non-interactive `codex exec`, identical to the `-c` case.
- **`--dangerously-bypass-hook-trust`**: this flag does run an untrusted hook (confirmed: the hook fired). But it exists only on `codex exec` — `codex app-server --dangerously-bypass-hook-trust` is a hard CLI error (`unexpected argument`). It also does not persist trust to `config.toml`; re-running without the flag goes back to silent-skip. There is no way to use it to bootstrap trust for later unattended `app-server` runs.
- **Trust hash**: Codex persists trust for a hook as `[hooks.state."<file>:<event>:…"] trusted_hash = "sha256:…"` in `config.toml`. The hash is not the SHA-256 of the command string or any obvious JSON serialization of the hook entry (tried several; none matched an existing real entry). No CLI subcommand computes or writes it. The daemon has no way to produce a trusted hash without going through Codex's own (interactive) trust-review flow once, which an unattended daemon launch cannot do.
- **Managed hooks**: `codex app-server generate-json-schema` exposes a `ManagedHooksRequirements` type and a `HookSource` enum with `mdm`, `cloudRequirements`, `cloudManagedConfig` members, whose trust status is `managed` (bypasses review entirely). This looks like an enterprise/MDM provisioning mechanism with no documented local activation path (no config key, env var, or CLI flag found that populates it). Pursuing it further would mean guessing at an undocumented, version-fragile surface — out of scope for a local daemon feature.

**Consequence:** Codex children cannot be given any guard the daemon can prove works unattended. Per the guards-first policy (KTD-3), no `codex/` ref may enter a live pool until this is resolved. The guard endpoint, guard CLI, and guard health modules (what would have been U3/U4) were not built — writing them against a hook that never fires would be guard theater, not a guard.

If a later Codex release adds an unattended-automation path for hook trust (a documented CLI flag that works under `app-server`, or a documented way to pre-seed `config.toml`'s trust hash), re-run the three checks above against the new version before resuming this work.

## Limitations and future work

- Guarding `apply_patch` and MCP calls awaits follow-up work.
- Adding newly ranked models to pools automatically is deferred.
