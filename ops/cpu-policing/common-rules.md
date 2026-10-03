## Context every workstream shares

Tyler's Mac (16 cores) pins its CPU about once a day. On 2026-09-24 he had to reboot at ~21:06Z. At 20:39Z the daemon logged "Resource monitor cannot sample processes; process legs are off until ps works" (`packages/server/src/server/agent/process-sampler.ts`): the monitor went blind exactly when the machine saturated. Five minutes after boot the stopgap guard (`~/bozeo-ops/cpu-guard.mjs`, LaunchAgent `sh.bozeo.cpu-guard`, log `~/Library/Logs/Bozeo/cpu-guard.log`) saw load 38 on 16 cores; agent CLIs used 720% CPU, mostly a backend agent's .NET `VBCSCompiler` (439%) and an Android agent's Gradle JVM (271%). Many agents run dotnet, Gradle, xcodebuild, tsgo, vitest and Playwright at once. Earlier the same day ~11 agents were resumed within seconds of each other after an account failover. The daemon's own forge polling (`git fetch`, `tea api` pagination) also spawns subprocesses; "Failed to run forge PR status self-heal refresh" appeared 83 times in about 2 hours.

Tyler's standing strategy: a deterministic daemon job fixes the problem; an LLM agent is spawned only when the job can't (the remediation ladder, `docs/remediation.md`); Tyler is notified only when that fails too (`docs/notification-policy.md`). Read `docs/resource-monitor.md`, `docs/remediation.md` and `CLAUDE.md` before you start.

Everything ships cross-platform: macOS AND Windows, and Linux must not break. Facts you can rely on:
- `os.setPriority(pid, n)`: libuv maps nice values to Windows priority classes: `n >= 19` → IDLE, `10..18` → BELOW_NORMAL, `0..9` → NORMAL, negative → higher classes. `os.constants.priority.PRIORITY_BELOW_NORMAL` is 10.
- Children inherit the nice value on macOS and Linux. On Windows a child defaults to its parent's class when the parent is IDLE or BELOW_NORMAL.
- On macOS/Linux only root can raise priority again, so never lower anything the daemon might need back at normal priority (e.g. never the daemon itself).
- `util.promisify(execFile)` returns a promise with a `.child` property.
- The shared helper `packages/server/src/utils/process-priority.ts` (`lowerProcessPriority(pid, nice)`, `BACKGROUND_NICE`) is already committed. Use it; don't write another one. It never raises a priority and never throws.

## Rules

- You are in your own git worktree on your own branch; only edit files in it. Three sibling workstreams are running in parallel in other worktrees (named below) and the leader merges them, so stay inside your scope and keep edits to shared files (`packages/protocol/src/messages.ts`, `persisted-config.ts`, `daemon-config-store.ts`, `bootstrap.ts`, docs) small and self-contained so merges stay clean.
- Node is not on PATH: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`. `node_modules` and `dist` are already present (APFS clones). Never run `npm ci`/`npm install`.
- **Heavy steps take turns, machine-wide.** The machine is at load ~80 on 16 cores. Never run `npm ci`/`npm install`, `npm run build:*`, a workspace typecheck, or a vitest run directly: wrap each one in `~/bozeo-ops/cpu-policing/heavy.sh <command...>`, which holds one of two machine-wide slots shared by every CPU-policing agent and waits for a free one. Give the Bash call a long timeout (600000 ms): waiting for a slot counts against it. Always pass `--maxWorkers=2` to vitest. Batch your test files into one vitest run where you can rather than taking a slot per file. Lint and format are light and don't need a slot.
- TDD for each behavior: write the failing test, then the code. Run only the test files you touch: `~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2` from `packages/server` (or the relevant package). The machine is already loaded: never run a whole suite, never `npm run test`.
- Typecheck each touched workspace: `~/bozeo-ops/cpu-policing/heavy.sh npm run typecheck --workspace=@getpaseo/server` (and `@getpaseo/protocol` / `@getpaseo/app` / `@getpaseo/cli` if touched). If a cross-package type error looks stale after a protocol change, run `npm run build:client` (or `npm run build:server`) first. Don't patch around stale declarations.
- Lint and format: in these worktrees the npm scripts see no files unless you pass these flags (`.gitignore` contains `.paseo/`): `npm run lint -- -c .oxlintrc.json --no-ignore <files>` and `npm run format:files -- --ignore-path=/tmp/empty-ignore <files>` (create `/tmp/empty-ignore` containing `node_modules/` if missing). Commit with `LEFTHOOK=0` after running them by hand.
- Config follows the existing pattern for live-toggleable monitor config: the zod schema in `packages/server/src/server/persisted-config.ts`, the mutable config + patch schemas in `packages/protocol/src/messages.ts` (optional fields only; wire schemas stay pure, see `docs/protocol-compatibility.md`), and the merge in `daemon-config-store.ts`. Copy how `agents.resourceMonitor` is done. Settings are read fresh when used so a `paseo daemon reload` or a patch applies without a restart.
- Commit in logical pieces with clear messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do NOT push, do NOT merge, do NOT edit `~/.paseo/config.json`, NEVER restart the Paseo daemon on port 6767 (it runs you).
- Docs: integrate into the doc that owns the subject, rewrite what becomes wrong, don't append a paragraph to the bottom. Follow the "Writing docs" and "Doc voice" rules in `CLAUDE.md`. Code-level facts go in comments next to the code.
- Match surrounding code: comment density, naming, idioms. Read `docs/coding-standards.md` and `docs/testing.md`.
- An interrupted tool call is not a stop instruction: retry it and carry on.
- If you spawn subagents, never give them `ultracode` thinking.

## Your final message (the leader reads only this)

End with a report containing: the commits (sha + subject); every config key you added, with its default; how each behavior works on macOS vs Windows (vs Linux where different); the test files you ran and their results; typecheck and lint results; the seams other workstreams or the leader must wire (exact function/option names); and anything you left out and why.
