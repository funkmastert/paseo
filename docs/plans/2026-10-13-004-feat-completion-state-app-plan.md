# Completion state indicator — app slice

Contract (fixed by `~/bozeo-ops/briefs/completion-state.md`, server slice owns writing it):
`paseo.completion` = `"ready-to-merge" | "done"` label on an agent, optional `paseo.completion-note`
(≤200 chars). Absent label = no completion state.

## Design

The sidebar's existing per-row indicator is driven by `workspace.statusBucket`
(`SidebarStateBucket` = `"needs_input" | "failed" | "running" | "attention" | "done"`), computed
server-side and re-derived client-side in `workspace-agent-activity.ts` from the workspace's root
agent. Today's `"done"` bucket means "idle, nothing to report" — a different concept from the new
completion labels, which only mean something once the row is already idle. Rather than widen the
existing bucket enum (touches 5+ exhaustive switches: `getStatusDotColor`, `StatusGroupIcon`,
`shouldRenderSyncedStatusLoader`, `getStatusDotColorStyle`, pinned-grid dot), layer completion as a
second, orthogonal signal that only applies inside the existing `"done"` bucket:

```ts
resolveRowCompletionIndicator({ bucket, completionState }) =>
  bucket !== "done" ? null : completionState
```

This satisfies the precedence rule for free: needs_input/failed/attention/running are all
non-`"done"` buckets and win outright; a label that arrived while the bucket was anything but
`"done"` is ignored (the "stale while running" rule), without extra state.

## Steps

1. **`packages/app/src/utils/completion-state.ts`** (new). Label key constants, `CompletionState`
   type, `getCompletionStateFromLabels`/`getCompletionNoteFromLabels` (narrow, O(1), mirrors
   `agent-labels.ts`'s shape), and the pure `resolveRowCompletionIndicator` precedence function.
   Defined in `packages/app` (not `packages/protocol`) to avoid a merge collision with the server
   slice's label constants — the two only need to agree on the string literals, which the brief
   fixes.
2. **`packages/app/src/utils/workspace-agent-activity.ts`**: extend `WorkspaceAgentActivity` with
   `completionState`/`completionNote`, read once per root agent from `agent.labels` in
   `buildWorkspaceAgentActivityIndex` (already the collection-owner pass over the agents map — no
   new subscription).
3. **`packages/app/src/hooks/sidebar-workspaces-view-model.ts`**: thread `completionState`/
   `completionNote` through `EffectiveWorkspaceStatus` → `SidebarWorkspaceEntry`. Null in every
   branch except the final fall-through (workspace genuinely quiescent); explicit null elsewhere,
   per the "ignore while running" rule.
4. **`packages/app/src/utils/status-dot-color.ts`**: extend `getStatusDotColor` with an optional
   `completionState` input; when `bucket === "done"` and a state is present, return
   `theme.colors.accent` (ready-to-merge) or `theme.colors.statusSuccess` (done) instead of the
   idle null/border. Keeps this the one function that decides dot/indicator color.
5. **`packages/app/src/components/sidebar/sidebar-workspace-row-content.tsx`**: in
   `WorkspaceStatusIndicator`, when the resolved completion indicator is non-null, render
   `GitPullRequestArrow` (ready-to-merge) or `CircleCheckBig` (done — avoids colliding with the
   `CircleCheck` already used for the `attention` group icon) instead of the muted idle dot, each
   wrapped in `Tooltip`/`TooltipTrigger`/`TooltipContent` (`enabledOnDesktop`, no
   `enabledOnMobile`) plus an always-present `accessibilityLabel`. Tooltip body is the state label
   plus the note when present.
6. **`packages/app/src/pinned-grid/pinned-grid-status-dot.tsx`**: accept the same completion
   inputs and forward to `getStatusDotColor` so the compact strip dot picks up the new colors —
   no shape change, dots stay colored circles per `docs/design.md`'s dot-family rule.
   `pinned-grid-cell.tsx`/`pinned-grid-screen.tsx` pass `workspace.completionState` through.
7. **i18n**: add `agentList.completion.{readyToMerge,done}` to all 9 locales.
8. **Tests**: unit test for `resolveRowCompletionIndicator` (+ the two label getters); a row
   render test asserting both icons/tooltip text appear and that a non-`"done"` bucket never shows
   them even with a completion label present (stale-while-running case).

## Explicit defaults (no one to ask)

- Icon choice: `GitPullRequestArrow` / `CircleCheckBig` (lucide-react-native, already a repo dep).
- Colors: `theme.colors.accent` / `theme.colors.statusSuccess` — no new theme tokens.
- `paseo.completion-at` is not read client-side; not needed for the visual spec.
- Completion constants live in `packages/app`, not `packages/protocol`, to avoid a cross-branch
  merge collision with the server slice.
