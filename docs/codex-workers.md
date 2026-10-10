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

Codex refs are usable for children only while a self-test has recently proved the guard works (`agent/codex-guard-health.ts`). Three states: `unknown` (no self-test has run, or it errored/timed out), `green`, `red`. Both `unknown` and `red` make every `codex/` ref unusable.

**Self-test:** a scratch guarded Codex child, in a throwaway temp directory, asked to `touch` an ok file and a canary file. The self-test supplies its own `DeviceLaunchGate` for the one session — it never reuses the real device cap, since the canary must be denied regardless of the cap's state — that allows the ok path and denies the canary path. Green requires all of: an approval request arrived for the ok command, it was approved, the ok file exists; an approval request arrived for the canary command, it was declined, and the canary file does not exist. Anything else is red. A self-test that errors or times out leaves health exactly where it was — an infrastructure failure is not proof the guard is broken, so it does not get to claim one either way.

**When it runs:** at daemon start, and hourly after that (`bootstrap.ts`'s `checkCodexGuardSelfTest`), which checks `shouldRunCodexGuardSelfTest` and only actually runs the test when a day has passed or the Codex binary's `--version` output has changed since the last run.

**Live detection:** every top-level shell command item a guarded child completes is re-checked after the fact against the real catastrophe and device gates (`recheckCodexGuardCommandItem`, reusing `codex-guard.ts`'s `decideCodexGuardedCommand`). A command one of those gates would refuse, that ran with no approval request ever having been seen for it, turns health red immediately and cancels the agent's turn. A command on Codex's safe list (one that never needs to escalate, so never raises an approval request) is not a violation either way.

**Not yet wired: the classifier can't see this.** `isCodexGuardHealthy()` is exported and correct on the daemon side, but nothing yet carries it across the daemon/plugin boundary into `plugins/claude-account-pool/server/role-availability.ts`'s `isRefUsable`. Plugins don't import daemon modules directly — they call a `paseo.<namespace>` RPC action exposed through `PluginHookContext`, the same way `jev-availability.ts` polls `paseo.jev.status()`. A `paseo.codexGuard.status()`-shaped action (and its daemon-side handler) needs to exist before ranking can safely treat a `codex/` ref as usable. Until that lands, a `codex/` ref is not actually gated by guard health at the classifier level — don't put one in a live pool regardless of what this file's health state says.

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

## Classifier plumbing for a routed Codex child

A worker or reviewer the classifier routes to a `codex/` ref gets two things forced onto its create request (`role-router.ts`), unconditionally — an explicit request for some other Codex mode does not bypass either:

- **`modeId: "guarded"`.** Set whenever the decided model's provider is `codex`, so a routed Codex child always runs behind the guard (above).
- **The thinking clamp (`decideCodexThinking` in `classifier.ts`).** Codex has no entry in `world.thinkingCatalog` (Claude is the only provider that reports thinking options through `listModels`), and Codex's own effort ladder — `low`/`medium`/`high`/`xhigh` plus `max` and `ultra` — is not Paseo's. The requested (or leader-rule, or task-class-default) level is resolved the same way as the Claude path, then capped to `xhigh` whenever `thinkingLevelRank` returns undefined for it, or returns a rank above `xhigh`'s. That one check covers Codex's own `max` and `ultra`, Ultra Code, and anything unranked, uniformly. Recorded as an `override` with `reason: "codex-max-effort"`.

### Not yet wired

Three pieces from U5's design are **not implemented**. Don't rely on any of them:

- **The budget gate (KTD-9).** `agentModelPolicy.codex` (`maxWindowPct` 60, `maxReadingAgeHours` 2, `maxChildren` 3) exists as a schema with defaults (`CodexPolicySchema`/`DEFAULT_CODEX_POLICY` in `shared/role-policy-schema.ts`), but nothing reads it yet. The `codex` `session` window reading likely already reaches the plugin through the existing provider-agnostic usage poller (`usage-poll.ts` → `HealthTracker.windowUtilization("codex", "session")`, fed from `paseo.providers.listUsage()`) without new RPC plumbing — that path wasn't verified end-to-end. The reading-age check and the running-children count have no investigated plumbing at all.
- **Tool-profile Codex-awareness (KTD-8).** `applyToolProfile` (`shared/tool-profiles.ts`) always writes Claude-shaped `settings.permissions`/`disallowedTools`, regardless of target provider. For Codex, `read-only` should map to `sandbox_mode: "read-only"` instead, and a profile with denied tools that Codex has no way to express should make its `codex/` refs ineligible with a reason — neither exists yet.
- **The usability seam in `role-availability.ts`'s `isRefUsable`.** This is the single place PR B's ranking was meant to read Codex's health/budget/profile eligibility from without its own code (see the plan's "Seam for PR B"). It is deliberately untouched rather than half-wired: a seam that silently always returns "usable" (no guard-health check, no budget check) for `family === "codex"` would be worse than no seam, since it would look like Codex gating exists when it does not. Build this only once the health RPC bridge and the budget/tool-profile pieces above actually exist to feed it.

## Limitations and future work

- Guarding `apply_patch` and MCP calls awaits follow-up work.
- Adding newly ranked models to pools automatically is deferred.
