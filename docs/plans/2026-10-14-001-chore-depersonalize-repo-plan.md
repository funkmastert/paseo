---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "chore: depersonalize repo for installers"
date: 2026-10-14
---

# chore: Depersonalize repo for installers

**Origin:** `~/bozeo-ops/briefs/depersonalize-repo.md`. **Target repo:** this checkout (the fork, worktree `chore/depersonalize-repo`).

## Summary

Tyler's username, personal paths, and the fork handle standing in for "the current user" are hardcoded in ~60 tracked files. Remove them so a new installer's experience (and any example output) never shows Tyler's identity, without rewriting git history and without breaking any script that only ever runs on his machine.

## Problem Frame

Inventory (`git grep`, tracked files, excluding `package-lock.json`):

| Class                                                  | Scope                                                                                       | Count       | Fix                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------ |
| Home paths `/Users/<you>`                              | ops scripts, docs/plans (historical), test files, JSON fixtures, one doc comment            | 39 files    | `os.homedir()`/`$HOME`/`~` per surface     |
| GitHub handle `<fork-owner>` — project's own address   | README, install/release docs, `electron-builder.yml`, `stage-bozeo.sh`, skill doc           | ~9 files    | Keep as default (class a)                  |
| GitHub handle `<fork-owner>` — personal-owner stand-in | `remediation/config.ts` `personalOwners` default, 6 test fixtures, `docs/work-snapshots.md` | ~8 files    | Make dynamic, fallback `[]`                |
| `push-scan.py` design gaps                             | identities path has no env override; no dynamic home-path/username check                    | 1 file      | Add both                                   |
| launchd plists (no templating)                         | `ops/launch-agents/*.plist` incl. `retired/`                                                | 7 files     | `__HOME__` placeholder + installer         |
| Emails, tokens, tailnet/ngrok domains, device serials  | —                                                                                           | 0 real hits | Already fake or already generic; no change |

Emails, real secrets, and tailnet names were already clean (`push-scan_test.py`'s sample emails are synthetic; tailnet hostnames in fixtures are already `tail123`/`mac-mini` placeholders). `bozeo.ngrok.app` is the fork's own branded public endpoint (no personal identifier in it, documented self-hosted infra) — out of scope, left as-is.

## Key Technical Decisions

- **KTD-1 — `ops/` scripts get dynamic paths, not a portability rewrite.** `ops/README.md` documents these as Tyler's vendored personal automation, explicitly machine-specific. The fix (`os.homedir()` + an env-overridable checkout-root constant) removes the literal username string from tracked files without changing runtime behavior on his machine or pretending the scripts are now installer-facing.
- **KTD-2 — `personalOwners` fallback is `[]`, not a derived guess.** Research confirmed no authenticated-forge-username or daemon's-own-repo-owner value is reachable today without a new network call (`gh api user`, or a fresh `git remote` read outside the already-cached per-cwd slug cache). Per the brief, adding a new network call to populate a default is out of scope — fall back to empty with a log line. An empty `personalOwners` means the sweep always bundles locally instead of pushing a `backup/...` branch, which is the safe default for a value that used to assume "it's always me."
- **KTD-3 — `electron-builder.yml`'s `owner: <fork-owner>` needs no change.** `desktop-release.yml` already passes `-c.publish.owner=${GITHUB_REPOSITORY%%/*}` / `-c.publish.repo=...` in CI, so a fork's release workflow already publishes its own update feed. The YAML default only governs local, non-CI builds (`stage-bozeo.sh`), where it correctly defaults to the project's own address (class a). The existing YAML comment already documents the override; no doc debt here.
- **KTD-4 — Retired plists are templated, not deleted.** `ops/README.md` names them by filename as historical/do-not-reinstall record. Templating costs the same as deleting and keeps that documentation grounded.
- **KTD-5 — Bulk string replacement for fixtures/tests.** Every hit of literal `<you>` in test files and JSON fixtures is a path-shape placeholder (including the flattened Claude-project-dir form `-Users-<you>-paseo`). A single token swap (`<you>` → `someone`) preserves every path's shape in both forms with no per-file judgment calls.

## Implementation Units

### U1. Dynamic paths in `ops/*.mjs|sh`

**Goal:** remove literal `/Users/<you>` from every tracked `ops/` script while keeping identical runtime behavior on the maintainer's machine.

**Files:** `ops/announce-verification.mjs`, `ops/budget-resume-watch.mjs`, `ops/claude-token-keepalive.mjs`, `ops/failover-watch.mjs`, `ops/mobile-worktrees-report.mjs`, `ops/move-when-idle.mjs`, `ops/reclaim-worktrees.mjs`, `ops/rehome.mjs`, `ops/retire-merged-paseo-worktrees.mjs`, `ops/retire-merged-worktrees.mjs`, `ops/retire-worktrees.mjs`, `ops/work-audit.mjs`, `ops/ws-cleanup/cleanup.mjs`, `ops/ws-cleanup/inventory.mjs`, `ops/public-web/e2e-pair.mjs`, `ops/public-web/sidebar-dump.mjs`, `ops/git-hooks/pre-push`, `ops/stage-bozeo.sh`, `ops/README.md`.

**Approach:**

- Introduce one convention, matching the `HOME = os.homedir()` pattern already used in `disk-guard.mjs`/`failover-watch.mjs`: `const HOME = os.homedir();` then `const CHECKOUT = process.env.BOZEO_CHECKOUT ?? path.join(HOME, "paseo-worktrees", "bozeo");` for the checkout root, and `path.join(HOME, "bozeo-ops", ...)` for the personal ops dir.
- Files with a static `import ... from "<absolute literal>"` (e.g. `budget-resume-watch.mjs`, `claude-token-keepalive.mjs`, `move-when-idle.mjs`, `reclaim-worktrees.mjs`, `rehome.mjs`, `retire-merged-worktrees.mjs`, `retire-worktrees.mjs`, `work-audit.mjs`, `ws-cleanup/*.mjs`) switch that one import to a top-level `await import(path.join(CHECKOUT, "packages/.../dist/....js"))`, matching the dynamic-import style already used in `announce-verification.mjs`/`mobile-worktrees-report.mjs`.
- `ops/git-hooks/pre-push`: replace the hardcoded `python3 /Users/<you>/bozeo-ops/push-scan.py` with `python3 "$HOME/bozeo-ops/push-scan.py"`.
- `ops/stage-bozeo.sh`: `B=/Users/<you>/paseo-worktrees/bozeo` → `B="${BOZEO_CHECKOUT:-$HOME/paseo-worktrees/bozeo}"`.
- `ops/README.md`: update the "Machine-specific" paragraph to describe the home dir and checkout root as resolved at runtime (`os.homedir()` / `$BOZEO_CHECKOUT`) rather than literally hardcoded, and document the `BOZEO_CHECKOUT` override next to the existing "Edit `~/bozeo-ops`" instructions.

**Patterns to follow:** `ops/disk-guard.mjs:56-104` (`HOME` + `path.join`, env-overridable constants with `??`).

**Test scenarios:** `Test expectation: none -- these are hand-run personal scripts with no test suite; behavior is unchanged (same resolved paths on the maintainer's machine), verified by inspection and `node --check`/`bash -n` syntax check per file, not unit tests.`

**Verification:** `grep -rn "<you>" ops/` returns nothing; `node --check <file>` for each touched `.mjs`; `bash -n` for `stage-bozeo.sh` and `pre-push`.

---

### U2. Template launchd plists + installer

**Goal:** plists hold no literal home path; a script renders them for install.

**Files:** `ops/launch-agents/sh.bozeo.budget-resume-watch.plist`, `sh.bozeo.claude-token-keepalive.plist`, `sh.bozeo.disk-guard.plist`, `sh.bozeo.public-web.plist`, `sh.bozeo.worktree-retire.plist`, `ops/launch-agents/retired/sh.bozeo.cpu-guard.plist`, `sh.bozeo.failover-watch.plist`, new `ops/launch-agents/install.sh`, `ops/README.md`.

**Approach:** replace every `/Users/<you>` in each plist with the placeholder `__HOME__`. Add `ops/launch-agents/install.sh <plist-name>` that: resolves `$HOME`, `sed`s `__HOME__` → `$HOME` into a temp file, copies it to `~/Library/LaunchAgents/<name>` (or `~/Library/LaunchAgents.disabled/<name>` when invoked with `--retired`), and optionally runs `launchctl bootstrap`. Update `ops/README.md`'s existing `cp .../*.plist ~/Library/LaunchAgents/` install step (around the "Install one" section) to call the new script instead.

**Test scenarios:** `Test expectation: none -- shell installer for a single-user machine; verified by a manual dry run rendering one plist to a temp dir and diffing against the live installed copy's shape (no $HOME literal left, same keys/values otherwise).`

**Verification:** `grep -rn "<you>" ops/launch-agents/` returns nothing; `install.sh --dry-run sh.bozeo.disk-guard.plist` (or equivalent flag) prints a plist with the real `$HOME` substituted and valid XML (`plutil -lint`).

---

### U3. `push-scan.py`: env-overridable identities path, dynamic home/user check

**Goal:** close the two gaps the brief calls out — no env override for the identities file, and no dynamic check for the current user's own home path/username (why home paths slipped through before).

**Files:** `ops/push-scan.py`, `ops/push-scan_test.py`.

**Approach:**

- `IDENTITIES = os.environ.get("PUSH_SCAN_IDENTITIES", os.path.join(HOME, "bozeo-ops", "push-scan-identities.txt"))`. (The script already holds no literal identities — this only adds the override.)
- In `identities()`, union in two always-computed values: `HOME` itself (the pre-existing `os.path.expanduser("~")`) and `getpass.getuser()` (or `os.environ.get("USER")`), treated the same as file-sourced identities (matched case-insensitively against pushed content), so a literal home-dir path or bare username is caught even if `push-scan-identities.txt` is missing or stale.
- `push-scan_test.py` already uses fake identities throughout; add one new test case asserting a line containing the test's own sandboxed `HOME`-equivalent (or a monkeypatched home path) is blocked by this new dynamic check, without hardcoding any real identity.

**Test scenarios:**

- Happy path: a push whose diff contains neither the sandbox's home path nor username passes (existing tests already cover this shape).
- New behavior: a push whose diff contains the literal current-user home path is blocked, even with `push-scan-identities.txt` absent or empty — covers the exact gap that let the 39 home-path files land.
- Override: setting `PUSH_SCAN_IDENTITIES` to a test-local file makes the scanner read identities from that path instead of `~/bozeo-ops/...`.

**Verification:** `python3 -m pytest ops/push-scan_test.py`.

---

### U4. Dynamic `personalOwners`, <fork-owner>-as-personal-stand-in cleanup

**Goal:** stop defaulting the work-snapshot "is this my own repo" check to Tyler's handle; scrub the handle from fixtures where it stands in for "a personal owner" rather than "this project."

**Files:** `packages/server/src/server/remediation/config.ts`, `docs/work-snapshots.md`, `packages/server/src/server/agent-work-snapshot-sweep.test.ts`, `packages/server/src/server/agent/worktree-snapshot.test.ts`, `packages/server/src/server/done-janitor-worktree.test.ts`, `packages/server/src/server/attention-push-triage.test.ts`, `packages/server/src/server/jev/redact.test.ts`, `packages/server/src/server/jev/test-utils/redact-shapes.ts`.

**Approach:**

- `config.ts`: `personalOwners: snapshots?.personalOwners ?? []`, per KTD-2. Add a one-line log (at the call site in `worktree-snapshot.ts`, or inline where the resolver is invoked — implementer's call based on where a logger is already in scope) when the resolved list is empty and a backup falls through to bundling for that reason, so the behavior change is observable rather than silent.
- `docs/work-snapshots.md`: update the `personalOwners` row (`["<fork-owner>"]` → describe the new empty default and what empty means: never pushes a `backup/...` branch, always bundles).
- In the 6 test files, replace the literal `"<fork-owner>"` with a fake org, e.g. `"example-owner"` (or whatever reads best per call site — `attention-push-triage.test.ts` and the two `jev/` files use it only as flavor text in a sample URL, not as a `personalOwners` value).

**Test scenarios:**

- `worktree-snapshot.test.ts` / `agent-work-snapshot-sweep.test.ts`: with `personalOwners: []` and no override, a private-repo-origin worktree falls through to `writeBundle` instead of pushing — covers the new default directly (not just the renamed fixture).
- Existing fixture-rename cases keep their current assertions (owner list explicitly passed in test setup; renaming the fixture value and the matching remote URL together preserves meaning per the research above).

**Verification:** `npx vitest run packages/server/src/server/remediation/config.test.ts packages/server/src/server/agent-work-snapshot-sweep.test.ts packages/server/src/server/agent/worktree-snapshot.test.ts packages/server/src/server/done-janitor-worktree.test.ts packages/server/src/server/attention-push-triage.test.ts packages/server/src/server/jev/redact.test.ts --bail=1` (only if a `config.test.ts` exists; otherwise the four listed files cover the change).

---

### U5. Scrub remaining home-path literals (tests, fixtures, historical docs, one code comment)

**Goal:** every remaining tracked hit of `<you>` outside `ops/` and the plists becomes a fake-but-shape-preserving placeholder.

**Files:** `docs/plans/2026-09-23-001-feat-openrig-port-plan.md`, `docs/plans/2026-10-13-001-fix-ladder-restart-stale-episodes-plan.md`, `packages/app/src/context-usage/context-meter-model.test.ts`, `packages/app/src/context-usage/test-fixtures/normalized-haiku-200k.json`, `packages/app/src/context-usage/test-fixtures/normalized-opus-1m.json`, `packages/server/src/server/agent/device-detection.test.ts`, `packages/server/src/server/agent/device-gate-composition.test.ts`, `packages/server/src/server/agent/providers/claude/context-usage.test.ts`, `packages/server/src/server/agent/providers/claude/test-fixtures/context-usage-haiku-200k.json`, `packages/server/src/server/agent/providers/claude/test-fixtures/context-usage-opus-1m.json`, `packages/server/src/server/away-reply/attacks.test.ts`, `packages/server/src/services/quota-fetcher/providers/claude-account-pool.test.ts`, `plugins/claude-account-pool/server/windows.ts`.

**Approach:**

- Test files and JSON fixtures: literal token swap `<you>` → `someone` (per KTD-5), which correctly handles both the plain-path form (`/Users/<you>/...`) and the flattened Claude-project-dir form (`-Users-<you>-paseo`) in the same pass.
- Two historical `docs/plans/*.md` files: replace `/Users/<you>/...` with the equivalent `~/...` form (brief's documented convention for docs), preserving the rest of the sentence.
- `plugins/claude-account-pool/server/windows.ts` (lines ~15, ~37): the comment cites an absolute path to a sibling file purely for cross-reference; drop the `/Users/<you>/paseo/` prefix and cite the repo-relative path (`packages/server/src/services/quota-fetcher/providers/claude.ts`) instead — matches this repo's own doc convention (repo-relative references, never absolute paths).

**Test scenarios:** `Test expectation: none -- pure string substitution preserving path shape and test semantics; verified by re-running each touched test file (listed in Verify below), confirming unchanged pass/fail outcomes.`

**Verification:** `npx vitest run packages/app/src/context-usage/context-meter-model.test.ts packages/server/src/server/agent/device-detection.test.ts packages/server/src/server/agent/device-gate-composition.test.ts packages/server/src/server/agent/providers/claude/context-usage.test.ts packages/server/src/server/away-reply/attacks.test.ts packages/server/src/services/quota-fetcher/providers/claude-account-pool.test.ts --bail=1`; `npm run typecheck` covers `windows.ts` (comment-only change, but confirms nothing else broke).

---

### U6. Verify and close out

**Goal:** confirm the only remaining hits are the documented class-(a) project address and genuinely fake examples, and that nothing regressed.

**Approach:**

- Re-run `git grep "<you>"` (expect zero hits outside this plan's own prose, if any) and `git grep "<fork-owner>"` (expect only class-(a) files: `README.md`, `docs/install.md`, `docs/release.md`, `docs/fork-releases.md`, `docs/plans/2026-09-10-001-...`, `packages/desktop/electron-builder.yml`, `ops/stage-bozeo.sh`, `ops/work-audit.mjs`'s personal-remote-detection line (KTD left unchanged — it detects personal _fork_ origins for the offsite-copy warning, a different concern from `personalOwners`; confirm in U6 whether `work-audit.mjs:106`'s `<fork-owner>` regex should become the same `BOZEO_CHECKOUT`-derived owner or stay — leaning stay, since it specifically means "the fork," not "a personal owner," but verify against its surrounding comment before finalizing).
- Run `~/bozeo-ops/cpu-policing/heavy.sh npm run build:server`, then `heavy.sh npm run typecheck`, then `npm run lint` / `npm run format:files` scoped to every touched file.
- Run the targeted vitest files from U4/U5 and `python3 -m pytest ops/push-scan_test.py` from U3.
- Commit in small logical groups matching the units above (ops scripts; plists + installer; push-scan; personalOwners + fixtures; remaining test/doc scrub), using the commit-hook `PATH` export from the brief.

**Verification:** inventory grep output pasted into the final report; green typecheck/lint/targeted-tests; no `package-lock.json` or `package.json` version changes; no `git stash` used; nothing outside this repo touched.

## Scope Boundaries

**Out of scope / deferred to follow-up:**

- `bozeo.ngrok.app` and the `sh.bozeo.public-web` infra name — project branding, not a personal identifier; left as-is per the brief's "generic product words are not personal" guidance extended to the fork's own self-hosted endpoint name.
- `ops/work-audit.mjs`'s `<fork-owner>` personal-fork-origin regex — likely stays (it means "is this the fork," a class-(a) concern), confirmed during U6 rather than pre-decided here.
- Rewriting git history — explicitly off-limits (catastrophic action). Old commits still contain the data; noted in the final report.
- Anything under `~/bozeo-ops`, `~/.paseo`, `~/Library` (outside this repo) — not touched; the live LaunchAgents there still need re-rendering by the new installer as a manual follow-up after this merges.

## Verification Contract

- `git grep "<you>"` and `git grep "<fork-owner>"` (tracked files, excluding `package-lock.json`) re-run at the end; output reconciled against the classification table above.
- `npx vitest run <touched-file>` per touched TS test file (never the full suite); `python3 -m pytest ops/push-scan_test.py`.
- `heavy.sh npm run build:server`, `heavy.sh npm run typecheck`, `npm run lint`/`npm run format` scoped to touched files.
- No `package-lock.json`/`package.json` version bumps; no `--no-verify`; no `git stash`.

## Definition of Done

All six units landed as small commits, inventory grep shows only documented class-(a)/fake-example residue, targeted tests and typecheck/lint are green, and the final report lists SHAs, the classification table with final counts, what's dynamic now (including the plist installer step), what remains and why, and the live-LaunchAgents re-render follow-up.
