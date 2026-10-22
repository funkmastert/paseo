---
title: "tea api exits 0 on an HTTP error, so a forge poller has to check the response, not the exit code"
date: 2026-10-22
category: integration-issues
module: gitea-service
problem_type: integration_issue
component: tooling
symptoms:
  - "a PR that Gitea answers with 404 shows the PRs tab's failed error with a Retry, not the not-found state"
  - "the unit test for a missing PR passes, because the test runner throws on 404"
root_cause: wrong_api
resolution_type: code_fix
severity: low
tags: [tea, gitea, forge, pull-request-ledger, exit-code, http-status, known-gap]
---

# tea api exits 0 on an HTTP error, so a forge poller has to check the response, not the exit code

## Problem

`tea api` exits 0 whatever HTTP status the server returned (`gitea-service.ts:1271`). A Gitea 404 for `repos/{owner}/{repo}/pulls/{n}` arrives as exit 0 with an error object on stdout (a JSON body with a `message` field), not as a thrown command error. Code that decides "not found" from a non-zero exit or from `404` in stderr never sees it. This is a known gap in the PR ledger's status-by-identity fetch, found in review of PR #78 and not fixed.

## Symptoms

- `getPullRequestStatusByIdentity` returns `null` for a missing PR only when the runner throws. The test that proves it throws `new Error("tea: HTTP 404 Not Found")` (`gitea-service.test.ts:3127`), a path real `tea` doesn't take.
- With a real exit-0 error body, `runJson` hands stdout to `parseCliJsonOutput`, which fails the Zod schema and throws a `TeaCommandError` whose text is `tea JSON did not match the expected schema` (`forge-cli-command.ts:295`). `isGiteaNotFoundError` looks for `\b404\b` (`gitea-service.ts:1115`) and doesn't match, so the error propagates and `PullRequestsSession` answers `kind: "failed"` (`pull-requests-session.ts:200`) instead of `not_found`.

## What Didn't Work

Matching the text "not found" in the message. `isGiteaNotFoundError` deliberately matches the HTTP status only, since "not found" also appears in unrelated errors (a missing mirror config) that must still propagate.

## Solution

Not applied. The two options:

- Pass `-i` and read the status line, as `probeForgejoNamespaceByTea` does (`gitea-service.ts:1294`, parsed by `parseHttpStatus`). tea builds differ on whether the line lands on stdout or stderr, so parse both.
- Check the body shape before the schema: an object with `message` and none of `number`, `html_url`, `head` is an error response. Treat it as a 404 only when the status confirms it.

Add a test whose runner returns the error body with exit 0, not one that throws.

## Why This Works

Either option moves the not-found decision to the signal tea actually emits. A thrown-error test can't catch this class of bug, since the runner double decides what failure looks like.

## Prevention

- Every `tea api` call site that goes through `runJson` or `runJsonArray` has the same exposure (`gitea-service.ts:1468`, `:1577`, `:1637`, `:1786`, `:1891`, `:2049`). Mostly they fail loudly with a schema error, which is misclassified and not silent. A paging loop over an array endpoint also fails on the object body.
- Write fixtures from a captured tea response, not from what a thrown error would say.

## Related Issues

- [docs/pull-request-ledger.md](../../pull-request-ledger.md#status-by-identity) states the gap where the behavior lives.
