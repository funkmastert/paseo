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

## Codex guard health

Codex refs are usable for children only while a self-test has recently proved the guard works (`agent/codex-guard-health.ts`). Three states: `unknown` (no self-test has run, or it errored/timed out), `green`, `red`. Both `unknown` and `red` make every `codex/` ref unusable.

**Self-test:** a scratch guarded Codex child, in a throwaway temp directory, asked to run three commands in order: `touch` an ok file, `touch` a canary file, then `git push --force origin main` against a bare remote set up in the same scratch directory. The self-test supplies its own `DeviceLaunchGate` for the one session — it never reuses the real device cap, since the canary must be denied regardless of the cap's state — that allows the ok path and denies the canary path. The force-push is declined by the real catastrophe gate before the device gate is ever consulted, so the self-test instead subscribes to the session's timeline for the gate's own `rule: force-push-main` refusal text. Green requires all of: an approval request arrived for the ok command, it was approved, the ok file exists; an approval request arrived for the canary command, it was declined, and the canary file does not exist; the catastrophe gate's force-push-main refusal was observed. Anything else is red — including a self-test whose own device-gate stand-in happens to work while the real catastrophe gate's wiring is broken, which a two-command self-test could never catch. A self-test that errors or times out leaves health exactly where it was — an infrastructure failure is not proof the guard is broken, so it does not get to claim one either way. A live-detection red that lands on a different, concurrently-running guarded child while this self-test is still in flight stays sticky: the self-test checks, right before writing its own verdict, whether a newer red arrived after it started, and leaves it alone rather than overwriting it with a stale green.

**When it runs:** at daemon start, and hourly after that (`bootstrap.ts`'s `checkCodexGuardSelfTest`), which checks `shouldRunCodexGuardSelfTest` and only actually runs the test when a day has passed or the Codex binary's `--version` output has changed since the last run.

**Live detection:** every top-level shell command item a guarded child completes is re-checked after the fact against the real catastrophe and device gates (`recheckCodexGuardCommandItem`, reusing `codex-guard.ts`'s `decideCodexGuardedCommand`). A command one of those gates would refuse, that ran with no approval request ever having been seen for it, turns health red immediately and cancels the agent's turn. A command on Codex's safe list (one that never needs to escalate, so never raises an approval request) is not a violation either way.

**Not yet wired: the classifier can't see this.** `isCodexGuardHealthy()` is exported and correct on the daemon side, but nothing yet carries it across the daemon/plugin boundary into `plugins/claude-account-pool/server/role-availability.ts`'s `isRefUsable`. Plugins don't import daemon modules directly — they call a `paseo.<namespace>` RPC action exposed through `PluginHookContext`, the same way `jev-availability.ts` polls `paseo.jev.status()`. A `paseo.codexGuard.status()`-shaped action (and its daemon-side handler) needs to exist before ranking can safely treat a `codex/` ref as usable. Until that lands, a `codex/` ref is not actually gated by guard health at the classifier level — don't put one in a live pool regardless of what this file's health state says.

## Guarded mode: the daemon answers Codex's own approval requests

Codex children run in a `guarded` mode preset (`MODE_PRESETS.guarded`, internal — never offered in `CODEX_MODES`): `sandbox_mode: "workspace-write"` with `approval_policy: "on-request"`. A guarded child's `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` requests are answered in-process by the daemon instead of being surfaced to a person: `checkCatastrophe`, then the composed `deviceLaunchGate`, decide accept or decline before anything runs. No hook, no trust file, nothing written to `~/.codex`. Fails closed by construction — nothing runs until the daemon says yes.

**Why not hooks.** See "Guard hook: superseded" below — no hook delivery path survives unattended under `app-server`.

**Why not `danger-full-access` + `untrusted` (the first guarded-mode design).** Confirmed empirically against the real ChatGPT-bundled binary (0.160.0) on 2026-10-09:

- `approval_policy = "untrusted"` is rejected outright: `failed to load configuration: approval_policy = "untrusted" is no longer supported; remove this setting`. The top-level `codex --ask-for-approval`/`-a` flag's own `--help` confirms only `on-request` and `never` remain as plain string values (plus a `granular` object form).
- `sandbox_mode: "danger-full-access"` never triggers an approval request, with _any_ approval policy, `granular` included: nothing needs to escalate out of a sandbox that is already fully open, so there is nothing to ask about. Confirmed by running a guarded-shaped session and watching a `touch` outside the workspace succeed silently, with zero `permission_requested` events.

Re-checked a second time on 2026-10-09 against the installed binary (`codex-cli 0.160.0`, unchanged) after this finding was questioned: `codex exec -c 'approval_policy="untrusted"' -c 'sandbox_mode="danger-full-access"' ...` still fails immediately with the identical config-load error, before any turn runs. The result is reproducible, not a fluke of one run or one environment.

**What does work.** `sandbox_mode: "workspace-write"` with `approval_policy: "on-request"` — the same values Paseo's existing `auto` mode already uses for people. Proven end-to-end against the real binary: a command needing to escalate beyond the workspace root (deleting a file in `$HOME`, in this case) produces an `item/commandExecution/requestApproval` request _before_ the command runs; responding `accept` lets it run (the file was deleted); responding `decline` blocks it (the file still existed afterward, and the model reported "the escalated `rm` request was rejected"). The model has to recognize it needs to request escalation — a command it runs without flagging that just gets denied by the sandbox directly, with no approval request at all. Either way nothing catastrophic succeeds: a command the catastrophe gate would refuse either gets an explicit decline, or never executes because the sandbox denied it outright.

This changes what "guarded" means from the mode picker's `auto`: the _values_ are identical, but a guarded child's approval requests never reach a person — `handleCommandApprovalRequest`/`handleFileChangeApprovalRequest` detect the guarded mode and decide synchronously instead of creating a pending permission.

**File changes and the git-alias blind spot.** `item/fileChange/requestApproval`'s own params carry no path info — confirmed against the real app-server protocol — so `handleFileChangeApprovalRequest` looks up the touched paths from the `item/started` notification for the same item id, which always precedes the approval request. In-workspace writes never raise an approval request at all under `workspace-write` (they apply directly, with no `requestApproval` round trip); a `.git/` write does, even inside the workspace. Each reported path is resolved before it is tested: every existing path component is `lstat`-ed in order, and any symlink found — including a dangling one, whose target does not exist yet, the shape `apply_patch` "creating" a new file through a planted symlink takes — is read via `readlink` and resolved in its place, with a hop limit against a symlink cycle. A path that cannot be resolved at all, or exceeds the hop limit, is treated as sensitive. Guarded mode declines a (resolved) file change under any `.git/` or `.ssh/` directory, a `.gitconfig`/`$XDG_CONFIG_HOME/git/config`, a `.gitattributes` (filter drivers), or a shell rc file, and approves everything else — closing the path through which an always-accepted `apply_patch` could otherwise add a `pf = push --force origin main` alias to `.git/config`, which `checkCatastrophe`'s shell parser (`docs/catastrophe-gate.md`) would never recognize as a force-push once invoked as `git pf`. An item whose changed paths were never tracked at all (a malformed payload, a notification that never arrived) declines too, rather than falling through to an accept. `decideCodexGuardedCommand` closes the command-side half: it declines a `git` invocation carrying its own `-c`/`--config-env` option, a `GIT_CONFIG_KEY_*` environment assignment, or a `git config` subcommand (any form — legacy `git config <key> <value>`, `--global`/`--file`, or the newer `git config set <key> <value>`) that sets an alias, `core.hooksPath`, `core.sshCommand`, `core.fsmonitor`, `include.path`/`includeIf.*.path`, `url.*.insteadOf`, or any `*.helper` — including the one-command form (`git -c alias.pf="push --force origin main" pf`) that sets and invokes the alias in the same breath, and a quote-split key (`git config alia""s.pf ...`) that a plain-text regex over the command would miss but the shell's own word-expansion resolves to `alias.pf` same as everywhere else. All of these read the key off the same shell-tokenizer word the catastrophe gate itself parses, not off the unparsed command text.

## What this guard does not catch

Pattern-based, at parity with what Claude's own catastrophe-gate hook catches and misses (`docs/catastrophe-gate.md`'s "Known gaps": unresolvable values, code in another language or a script file, push config, the remote's own side, other routes to a shell or to moving a ref). Nothing here is Codex-specific — a gap in the shared `checkCatastrophe` parser is a gap for every provider it runs under.

Codex-specific gaps on top of that:

- **In-workspace writes raise no approval request at all.** Confirmed against the real app-server protocol (above): `workspace-write` applies a write inside the sandbox root directly, with no `requestApproval` round trip, so nothing in guarded mode ever sees it. The file-change sensitivity check above only runs for writes that do escalate — a `.git/`, `.ssh/`, or shell-rc path, which the sandbox treats as outside the workspace even when nested inside it.
- **Interactive shell input typed during a running turn gets no re-check.** A tool call is visible to the guard when the model presses Enter on it, not as it types into an already-running process — the same gap Claude has, and the same shape as `docs/catastrophe-gate.md`'s own "other routes to a shell" (`send_terminal_keys` arrives as terminal input, not a gated tool call).

## Guard hook: superseded, no unattended delivery path (Codex CLI 0.160.0)

The original guard design used a PreToolUse hook. No hook delivery path runs unattended under `codex app-server`— this is why guarded mode (above) exists instead. Keep this list as the recheck for a future Codex release:

- **`-c` config overrides** (`codex app-server -c 'hooks.PreToolUse=[...]'`): the key is accepted — `--strict-config` does not reject it — but the hook never runs. It is silently skipped with no log line, no error, no block.
- **`~/.codex/hooks.json`** (the file-based path the terminal activity hook installer uses): same result. A `PreToolUse` entry added directly to the real file is silently skipped under non-interactive `codex exec`, identical to the `-c` case.
- **`--dangerously-bypass-hook-trust`**: this flag does run an untrusted hook (confirmed: the hook fired). But it exists only on `codex exec` — `codex app-server --dangerously-bypass-hook-trust` is a hard CLI error (`unexpected argument`). It also does not persist trust to `config.toml`; re-running without the flag goes back to silent-skip. There is no way to use it to bootstrap trust for later unattended `app-server` runs.

(A `trusted_hash` mechanism in `config.toml` and a `ManagedHooksRequirements`/MDM-style path also exist and were ruled out — see git history on this file for the full detail.)

If a later Codex release restores an `untrusted`-equivalent approval policy that asks even under `danger-full-access`, or adds an unattended-automation path for hook trust, re-run the checks above (and the guarded-mode proof) against the new version before changing this design.

## Classifier plumbing for a routed Codex child

A worker or reviewer the classifier routes to a `codex/` ref gets, on its create request (`role-router.ts`), unconditionally — an explicit request for some other Codex mode or profile shape does not bypass any of this:

- **`modeId: "guarded"`.** Set whenever the decided model's provider is `codex`, so a routed Codex child always runs behind the guard (above).
- **The thinking clamp (`decideCodexThinking` in `classifier.ts`).** Codex has no entry in `world.thinkingCatalog` (Claude is the only provider that reports thinking options through `listModels`), and Codex's own effort ladder — `low`/`medium`/`high`/`xhigh` plus `max` and `ultra` — is not Paseo's. The requested (or leader-rule, or task-class-default) level is resolved the same way as the Claude path, then capped to `xhigh` whenever `thinkingLevelRank` returns undefined for it, or returns a rank above `xhigh`'s. That one check covers Codex's own `max` and `ultra`, Ultra Code, and anything unranked, uniformly. Recorded as an `override` with `reason: "codex-max-effort"`.
- **Tool profiles, Codex-shaped (KTD-8).** `applyToolProfile` (`shared/tool-profiles.ts`) takes a `targetFamily` argument; for `"codex"` it never writes Claude's `settings.permissions`/`disallowedTools`, since Codex has no per-tool denial mechanism this codebase knows of. `read-only` maps to `sandbox_mode: "read-only"` instead — Codex's own investigate-only mode. Every other profile with a real denial (its own, or inherited) cannot be expressed at all: `isToolProfileExpressibleOnCodex` says so, and `classifier.ts` folds that into the usability gate below rather than silently dropping the restriction. The check only sees the role's own configured profile — a denial inherited from the agent that spawned this one is not checked yet (`decideModel` has no access to that half of the tool decision).
- **The usability gate (KTD-9, KTD-3), `role-availability.ts`'s `isRefUsable`.** A `codex/` ref is usable only when all of: `isCodexGuardHealthy()` is true, the `codex` `session` window reading is under `agentModelPolicy.codex.maxWindowPct` (default 60) and under `maxReadingAgeHours` old (default 2), fewer than `maxChildren` (default 3) Codex children are running, the role isn't the leader, and the role's tool profile is expressible on Codex (above). Every one of these fails closed on missing data. The window reading and its age come from the existing provider-agnostic usage poller (confirmed: `services/quota-fetcher/providers/codex.ts` reports Codex's primary window under window id `"session"`, the same id KTD-9 names) — no new RPC needed for budget. `health.ts` gained `windowReadingAgeHours` for the age half.

### Still not wired: guard health itself

`isCodexGuardHealthy()` (above) is correct on the daemon side, but nothing yet carries it across the daemon/plugin boundary. Plugins don't import daemon modules directly — they call a `paseo.<namespace>` RPC action exposed through `PluginHookContext`, the same way `jev-availability.ts` polls `paseo.jev.status()`. A `paseo.codexGuard.status()`-shaped action (and its daemon-side handler) needs to exist before a live daemon can actually pass a real `isCodexGuardHealthy` into the classifier's `world`. Until that lands, `ClassifierWorldBase.isCodexGuardHealthy` is never supplied in production, which the usability gate above treats as unhealthy by design (guards-first, KTD-3) — so no `codex/` ref is usable yet, correctly, everywhere this classifier runs. The `agent_model_policy` preview RPC (`role-policy-rpc-handlers.ts`) has no path to supply it either, and correctly reports a `codex/` ref as `unavailable` rather than claiming a model it cannot actually route to.

Running-children count (`ClassifierWorldBase.runningCodexChildren`) has the same gap: nothing feeds it yet, so it defaults to zero, which the gate treats as permissive — moot while guard health above is also unwired.

## Limitations and future work

- Guarding MCP calls awaits follow-up work.
- Adding newly ranked models to pools automatically is deferred.
