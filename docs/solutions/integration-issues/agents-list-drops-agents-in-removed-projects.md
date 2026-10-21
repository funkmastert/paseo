---
title: Removing a project record hides its archived agents from paseo.agents.list(), so run history backfills before bulk project cleanup
date: 2026-10-21
category: integration-issues
module: claude-account-pool-classifier-dashboard
problem_type: integration_issue
component: tooling
symptoms:
  - "the classifier dashboard backfill found 246 of 295 historical paseo.arena-pick agents"
  - "the 51 missing agents were all archived, and all belonged to projects removed minutes earlier"
  - "agents.list({ filter: { includeArchived: true } }) returns no error and no marker for the agents it leaves out"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: medium
related_components:
  - done-janitor
  - plugin-api
tags:
  [
    agents-list,
    backfill,
    project-removal,
    orphaned-agents,
    fetch-agents,
    placement,
    classifier-decisions,
  ]
---

# Removing a project record hides its archived agents from paseo.agents.list(), so run history backfills before bulk project cleanup

## Problem

After 61 empty projects were removed (record only), the classifier dashboard's one-time backfill (`plugins/claude-account-pool/server/classifier-decisions-backfill.ts`, funkmastert/paseo#70) saw 246 of 295 historical `paseo.arena-pick` agents. The 51 missing agents were all archived, and all lived in the removed projects. The backfill is gated by a `backfilledAt` marker, so the gap would have been permanent.

## Root cause

`paseo.agents.list()` is the client's `fetchAgents` (`packages/client/src/index.ts:628`), which the daemon serves through `listFetchAgentsEntries` (`packages/server/src/server/session.ts:5496`). Every candidate agent needs a project placement, and an agent without one is dropped:

- `buildProjectPlacementForWorkspaceId` returns `null` when the workspace's project record is gone (`session.ts:2172-2173`).
- `collectFetchAgentsEntries` skips an agent whose placement is `null` (`session.ts:5470-5471`).

`includeArchived: true` only lifts the archived filter (`session.ts:5283`, `5300`). The agent record stays in storage; the list just cannot reach it through a project that no longer exists. Removing a project is record-only (`docs/done-janitor.md`), so the workspaces and agents survive and become orphans.

## Solution

Order the work so history is read before it is orphaned: run any one-time backfill or export that sweeps `agents.list()` before a bulk project cleanup. For a sweep that must see orphaned agents, read through an API that includes them instead of `agents.list()`.

The backfill sets `backfilledAt` after any sweep that finishes (`classifier-decisions-backfill.ts:165`), and a sweep that silently omitted orphans finishes. A run that missed rows needs the marker cleared before it can repeat.

## Prevention

- Treat `agents.list()` as "agents in existing projects", not "all agents". Say so in the comment of any sweep that stakes a one-time marker on it.
- A one-time backfill that sets its own done marker should log the count it saw, so a shortfall against what the operator expects is visible before the marker is set.
- Before a bulk cleanup that removes records other readers join through, list the readers of those records.
