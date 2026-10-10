# Worktree disk sweeper + per-workspace disk-usage indicator

Status: design complete, building (phases 1+2; phase 3 deferred).
Provenance: design agent (Sonnet 5) on 2026-09-12, verified against `dbea2950a`. Context: disk hit 99% (12GB free); ~/.paseo/worktrees = 49-50GB; fat = node_modules/build output, not checkouts.

## User ask

"Some agents are giving huge workspaces and never cleaning it up. We need a daemon for that perhaps, and we should have a visual indicator similar to token use indicator but for disk space."

## Evidence highlights

- Archive already deletes worktree dirs when safe (`workspace-archive-service.ts:350-420`: paseo-owned + unreferenced + teardown/delete succeed). **True orphans come from the failure/skip paths** — teardown errors and delete errors are caught, logged, never retried; stale sibling records pin dirs; legacy placement drift (COMPAT `:291`).
- **No reconciliation cross-checks disk against the registry** — `WorkspaceReconciliationService` handles dir-missing, not dir-unreferenced. No "orphan" sweep exists for worktree dirs.
- **`deletePaseoWorktree` has zero git-safety gate** (`utils/worktree.ts:1071-1140`) — fine for explicit archive, a regression if reused blindly by a sweeper; the sweeper owns its own gate via `getCheckoutStatus` (`checkout-git.ts:2191`).
- **Dominant 49GB contributor is live-but-idle workspaces** — never archived, invisible today. Hence two halves: sweeper reclaims archived-but-undeleted; the indicator makes fat-active workspaces visible so a human archives them (auto-deleting active workspaces stays out of scope; archive remains explicit per docs/agent-lifecycle.md).
- Templates: `AgentTokenBurnMonitor` (config-driven tick + push, `bootstrap.ts:1762-1772`/`:1844`), sweeps' positive-evaluation rule, `553af7e5e` live-toggle plumbing, `archivingAt` in-memory merge in `WorkspaceDirectory.buildDescriptorMap` (`workspace-directory.ts:252-256`), `statfs` precedent (`diagnostics.ts:158-166`), `execCommand` with timeout for `du -sk`.

## Resolved decisions

| Decision           | Choice                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-delete scope  | ONLY dirs backing archived or registry-unknown workspaces — never active ones                                                                                                                                                                     |
| Retention          | 7 days default after archive before sweep-delete                                                                                                                                                                                                  |
| Safety gate        | `getCheckoutStatus`: isGit, not dirty, not ahead-of-origin (ambiguous ⇒ keep); sweeper owns this, `deletePaseoWorktree` unchanged                                                                                                                 |
| Unsafe orphans     | Never delete; log + push once/day per path, batched                                                                                                                                                                                               |
| Throughput         | maxDeletionsPerTick 5 (first-run backlog must not storm I/O)                                                                                                                                                                                      |
| Emergency          | minFreeGB 5 via statfs each tick → immediate out-of-cycle sweep (still gated) + urgent push                                                                                                                                                       |
| Config             | `worktrees.diskSweeper {enabled, sweepIntervalMs 600000, retentionDays 7, maxDeletionsPerTick 5, minFreeGB 5, sampleTimeoutMs 30000}`, strict, live-toggleable via the tokenBurnMonitor pipeline                                                  |
| Sampling           | `du -sk` via execCommand w/ timeout, own tiny sequential queue (NOT the git limiter); rotating cursor 1 workspace/tick + sample-on-archive + lazy sample-on-first-view; undefined on failure, never 0                                             |
| Metric persistence | None — in-memory, like tokenRateBuckets                                                                                                                                                                                                           |
| Protocol           | `WorkspaceDiskUsageSchema {bytes, sampledAt}`; `diskUsage` nullable-optional on `WorkspaceDescriptorPayloadSchema` (:3915), no COMPAT tag                                                                                                         |
| Indicator          | ABSOLUTE thresholds client-side (disk bytes have fixed meaning, unlike relative burn): warn >2GB, danger >10GB, client constants; reuse ProviderUsageTone vocabulary + icon+text (never color alone); no chip when unsampled or below floor       |
| UI home            | Sidebar workspace meta row (`workspace-meta-row/`), new `diskUsage` MetaRowItem shaped like ChecksItem/ServiceItem, HardDrive icon + size, tooltip "2.4 GB · sampled 6h ago", toggleable via useSidebarMetaPreferences                            |
| Notifications      | `disk-sweep-notification.ts` mirrors token-burn-notification: reclaimed (batched count+bytes), unsafe-orphan (daily re-arm), disk_space_critical (once per crossing, clears on recovery). No agentId deep-link — accepted degradation on old apps |

## Server design

**`WorktreeDiskMonitor`** (new `packages/server/src/server/worktree-disk-monitor.ts`, one unref'd timer): tick = fresh config read → early-out disabled → statfs emergency check → enumerate on-disk worktree dirs per project root → diff vs referenced set (active + in-grace archived) → per candidate past retention: getCheckoutStatus gate → delete via existing deletePaseoWorktree (sample size BEFORE delete for the notification) or queue unsafe notification; capped per tick → advance sampling cursor by one active workspace → drain lazy/archive-time sample requests → batch pushes. Constructed/started/stopped in bootstrap beside AgentTokenBurnMonitor.

**Pure modules:** `worktree-disk-sweep-detector.ts` `evaluateDeletionCandidate({onDiskPath, registryState, retentionDays, checkoutStatus, nowMs}) → delete | keep-unsafe | keep-in-grace`; `utils/directory-size-sampler.ts` `sampleDirectorySizeBytes(path, {timeoutMs}) → number | undefined`.

**Wiring:** `WorkspaceDirectoryDeps.getDiskUsage(workspaceId)`; merge in buildDescriptorMap like archivingAt; lazy-sample enqueue on first workspace hydration; archive-time sample hook in workspace-archive-service.

## Client design (phase 2)

`utils/disk-usage-tone-model.ts` pure thresholds; `meta-items.ts` diskUsage kind selected only when present + above floor; `DiskUsageItem` in workspace-meta-row (statusWarning/statusDanger only at tone, muted otherwise); display-preferences toggle entry.

## Test list

Server: detector (grace keep / past-retention+safe delete / dirty keep / unresolvable keep / untracked=archived semantics); sampler (parse, timeout→undefined, nonzero-exit→undefined, never 0); monitor (disabled early-out, per-tick cap, emergency out-of-cycle, daily re-arm, rotation advances one, request-drain priority, reclaimed-bytes math); config live-toggle round-trip; buildDescriptorMap merge + wire-compat legacy replica; e2e: failing-teardown leftover swept only after retention + clean git, dirty leftover never deleted.
Client: tone model (floor/warn/danger/missing⇒no chip); meta-items selection + preference toggle.

## Phasing

1. Server: monitor + detector + sampler + protocol field + config + wiring. Observe against the real 49GB tree.
2. App: meta-row item + tone model + preference toggle; tune 2/10GB from phase-1 data.
3. Deferred: manual "prune now" CLI trigger; diagnostics rollup.
