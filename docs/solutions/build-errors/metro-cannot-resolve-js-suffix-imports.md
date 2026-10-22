---
title: App code can't import siblings with a .js suffix, because Metro won't resolve it to the .ts file
date: 2026-10-22
category: build-errors
module: app-metro-bundle
problem_type: build_error
component: tooling
symptoms:
  - "Metro fails the web bundle with Unable to resolve module ./use-data.js"
  - "the desktop stage aborts although vitest and typecheck are green"
root_cause: missing_tooling
resolution_type: tooling_addition
severity: medium
tags: [metro, app, imports, js-extension, nodenext, oxlint, no-restricted-imports]
---

# App code can't import siblings with a .js suffix, because Metro won't resolve it to the .ts file

## Problem

PR #78 (the PRs tab) added `use-data-by-identity.ts` and `use-forge-status-by-identity.ts` under `packages/app/src/git/pull-request-panel/`, and their tests, importing siblings as `./use-data.js` and `./query-keys.js`. The Metro bundle for web and native could not resolve those specifiers, so the 2026-10-22 desktop stage aborted. PR #81 stripped the suffix.

## Symptoms

- `Unable to resolve module ./use-data.js` from the web bundle.
- `vitest`, `tsc`/`tsgo` and `npm run lint` all passed.

## What Didn't Work

Nothing was tried; the cause was readable from the error. The question was why nothing caught it before the stage ran.

## Solution

Drop the suffix from every relative and `@/` import in `packages/app/src`: `./use-data`, not `./use-data.js`.

Lint now enforces it. `.oxlintrc.json` carries a `no-restricted-imports` `patterns` entry, regex `^(\.{1,2}/|@/).*\.js$`, in every override that sets that rule. It flags static `import … from` and `export … from`, and does not see dynamic `import()` or `vi.mock()` strings.

## Why This Works

`packages/server` and `packages/protocol` compile as NodeNext ESM (`packages/server/tsconfig.server.json:4`, `packages/protocol/tsconfig.json:4`), where a relative import must say `.js` even though the file on disk is `.ts`. Writing that suffix is a habit there. The app extends `expo/tsconfig.base` and is bundled by Metro, which looks for a file literally named `use-data.js` and finds none. `tsc` and vitest both map `.js` back to `.ts`, so every check that ran on this tree accepted the specifier. Only a Metro bundle rejects it, and no merge gate runs one.

## Prevention

- **Lint rule scope.** A later matching override replaces an earlier one's `no-restricted-imports` config wholesale, so the pattern is repeated in all six blocks of `.oxlintrc.json` (the base app block, the `data`/test block, both burn-down lists, the overlap list and the `text-input` exemption, which changed from `"off"` to patterns-only). A new block that sets `no-restricted-imports` must carry the pattern or it silently exempts its files. Probes confirmed each block flags `./x.js`.
- **`import/extensions` doesn't work for this.** In oxlint 1.61 it flags `.js` on package specifiers but not on relative ones, and `"never"` also flags `.css` and `.json`.
- **Gap.** The rule covers `packages/app/src` only. A Metro bundle is still the only full check, and nothing in the merge gate runs one.

## Related Issues

- [docs/coding-standards.md](../../coding-standards.md) lists the rule.
