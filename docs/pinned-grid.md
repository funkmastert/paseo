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
and `WorkspacePaneContent`, so streaming, status, the composer, and permission prompts work in
place with no second chat renderer. The grid has no tab
strip or layout of its own; anything a panel asks the workspace to open (a file, a diff, a side
pane) opens in the workspace and leaves the grid.

Two things a cell does on its own account:

- It reports its agent to `viewedTimelineSync` under its own source id, so the stream stays live
  while the cell is on screen without touching the workspace screen's report.
- It is unfocused until touched. Focus is what the agent panel reads as "the user is looking at
  this", and it clears the agent's attention, so an unfocused grid is read-only towards the daemon.

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
it. A phone cannot tile two usable composers, so the other chats are not mounted; the strip's
status dots keep reporting them.

One pin skips the grid: the button opens that workspace, as a row press does.

## Capturing it against a live daemon

The daemon accepts browser origins from `https://app.paseo.sh` only. Bridge the WebSocket through
a Node process that forwards to `127.0.0.1:6767` without an `Origin` header, and have the bridge
drop every client frame that is not a read request. Focusing a cell sends `clear_agent_attention`,
which the bridge should drop when the daemon is not a throwaway.
