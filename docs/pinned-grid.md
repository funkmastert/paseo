# Pinned grid

The grid button in the sidebar's Pinned section opens every pinned chat at once, each one live.

## What "pinned" means

Pinned is a workspace property (`workspace.pin.set`, `pinnedAt`), not an agent label. The Pinned
section lists workspaces. `paseo.keep` is unrelated and does not put anything in the section.

A workspace can hold several agents and the grid shows one chat per pin: the most recently active,
non-archived root agent (`pinned-grid/resolve-pinned-agent.ts`). The open button in a cell's header
reaches the rest of the workspace.

## What a cell is

A cell mounts the same agent panel a workspace tab mounts, through `buildWorkspacePaneContentModel`
and `WorkspacePaneContent`, so streaming, status, and permission prompts work in place with no
second chat renderer. It passes `readOnly: true` on the pane context, which the agent panel
(`packages/app/src/panels/agent-panel.tsx`) reads to drop the composer, its tracks, and forking —
a cell is a glance, not a place to type. Question cards, plan approval, and permission requests
stay interactive: `AgentStreamView`'s own `readOnly` prop (already used by the subagent panel) only
turns off forking, and `QuestionFormCard`'s `allowFreeText={false}` swaps a question's free-text
input for a hint pointing at the full conversation — everything option-based still answers in
place. The grid has no tab strip or layout of its own; anything a panel asks the workspace to open
(a file, a diff, a side pane) opens in the workspace and leaves the grid.

Clicking anywhere in a cell that isn't an interactive card, button, link, or a text selection opens
that workspace — the same navigation as the header's explicit open button. The click lives on a
`Pressable` wrapping the body; nested `Pressable`s (question cards, links) claim their own press
first and stop it from reaching the body's handler, and a `window.getSelection()` check skips
navigation when the click was really the end of a text-selection drag. Hover tracking lives on the
outer cell `View` per docs/hover.md, not on that `Pressable`, so hovering into the nested cards
never fights it.

Three things a cell does on its own account:

- It reports its agent to `viewedTimelineSync` under its own source id, so the stream stays live
  while the cell is on screen without touching the workspace screen's report.
- It is unfocused until touched. Focus is what the agent panel reads as "the user is looking at
  this", and it clears the agent's attention, so an unfocused grid is read-only towards the daemon.
- It never becomes a place to type: the composer is gone, not just hidden, so there is no draft
  state to lose track of between the cell and the real conversation.

## Where it lives

`/pinned-grid` is an app-wide route beside `/schedules`, because pins span hosts. The screen builds
its own `SidebarModelProvider`, which reads the same stores and filters as the sidebar's, so the
grid shows exactly what the section lists. Leaving is `router.back()`; a cold load with nothing
behind it falls back to the last workspace.

## Layout

`pinned-grid-layout.ts` owns the numbers. Columns follow the width in minimum-width steps (up to
four); rows share the height until a cell would drop under the minimum height, and then the grid
scrolls at that height. Nothing is dropped at any count, so twelve pins is a scrolling grid of
twelve mounted panels.

Compact form factors get a strip of the pinned chats with live status and one full-size chat below
it. A phone cannot show more than one useful transcript at a time, so the other chats are not
mounted; the strip's status dots keep reporting them. The selected chat is the same read-only,
tap-to-open cell as the wide layout.

One pin skips the grid: the button opens that workspace, as a row press does.

## Capturing it against a live daemon

The daemon accepts browser origins from `https://app.paseo.sh` only. Bridge the WebSocket through
a Node process that forwards to `127.0.0.1:6767` without an `Origin` header, and have the bridge
drop every client frame that is not a read request. Focusing a cell sends `clear_agent_attention`,
which the bridge should drop when the daemon is not a throwaway.
