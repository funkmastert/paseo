---
title: "fix: MCP status strip reads as a wall of red"
type: fix
status: active
date: 2026-10-07
---

# fix: MCP status strip reads as a wall of red

## Problem

The sidebar's MCP status strip (`packages/app/src/mcp-status/`) is hard to read and act on. From
Tyler's screenshot (desktop sidebar, expanded, 5 unhealthy servers and ~10 healthy ones):

1. **Header lists names and truncates.** "MCP issues: claude.ai Robinhood, figma, linear, n…". A
   list of names does not fit a sidebar row, and once expanded it repeats the rows below.
2. **Healthy servers sit in the problem list.** agent-gateway, amplitude and every other connected
   server render as full rows under the problems, so the expanded strip is mostly noise and runs
   long enough to push the workspace list off screen.
3. **Status dots float.** The row uses `alignItems: "center"`, so the dot centres on the whole
   name + status + button block. It sits on the name line on one row and between lines on the next.
4. **Failure text is off the rail.** The failure block starts at the dot's left edge, not under
   the name (docs/design.md §8).
5. **Walls of red.** Every failure renders in `statusDanger`, including multi-sentence setup
   guidance that is not an error the reader caused (figma, slack). The dot already carries tone.
6. **Clamp with no affordance.** The failure is clamped to two lines and opens on tap, but nothing
   says it can be opened.
7. **Copy icon everywhere, on its own rail.** Every failure has a copy icon, ~20px inside the
   action button's right edge, even for a one-line "Sign-in failed: Invalid refresh token".
8. **Hand-rolled buttons.** The action is a `Pressable` wrapping `Text` styled as a filled accent
   button, repeated on every row. docs/design.md §4 says the button is `<Button>`, and accent is
   one CTA per surface.
9. **Status line duplicates the failure.** "Needs auth" over "Sign-in failed: …" says the same
   thing twice. The claude.ai row's status, "Sign in per Claude account · On cl…", truncates and is
   jargon.
10. **Dead ends stay issues forever.** figma (the provider refuses client registration) and slack
    (needs a hand-registered OAuth app) have no button and cannot be fixed from Paseo. So can't a
    claude.ai connector Tyler does not use (Robinhood). They keep the header amber permanently, so
    the dot stops meaning anything.

## Decisions

- **Header:** one unhealthy row → name it ("linear needs sign-in"). Several → count
  ("5 MCP servers need attention"). None → "{{count}} MCP servers connected". Unhealthy critical
  servers still decide the tone first, as today.
- **Groups, in order:** unhealthy rows with an action; unhealthy rows without one; then one muted
  disclosure row, "{{count}} connected" (connected, connecting and disabled servers), collapsed by
  default, that expands to compact one-line rows (dot + name, status trailing in muted text). Then
  a "{{count}} hidden" disclosure if any are hidden. Disclosure state is chrome, not persisted.
- **Row layout:** dot aligned to the name's first line (`alignItems: "flex-start"` and an offset
  computed from the name's line height, not a magic number, with a comment). Everything under the
  name starts on the name's rail. The trailing slot holds at most one control, and its right edge
  is the strip's trailing rail.
- **Second line:** the failure sentence when there is one, otherwise the status label. Never both.
  Clamped to two lines, `foregroundMuted`. When there is more to read (the text is clamped, or the
  failure has remedy lines), a visible "More" / "Less" text affordance sits under it on the name
  rail. Expanded shows the full sentence, the remedy lines, and Copy, as a ghost `xs` button with
  the copy icon, on the trailing rail. No copy icon in the collapsed state.
- **Buttons:** `<Button size="xs" variant="outline">` with `leftIcon`. Labels: "Sign in" (was
  Authenticate), "Sign in again" (was Re-authenticate), "Sign in" with the external-link icon for
  claude.ai connectors (was "Open claude.ai"), "Broker & sign in" unchanged.
- **Copy:** status "Needs auth" → "Needs sign-in". claude.ai connector status → "claude.ai
  connector", with the reporter after it ("claude.ai connector · on claude-2"). Everything else in
  `en.ts` stays unless a decision above changes it. Add every new key to every locale file in
  `packages/app/src/i18n/resources/` the way the repo does it today.
- **Hide:** any unhealthy row can be hidden. Rows with no action show a ghost `xs` "Hide" button in
  the empty trailing slot. Every unhealthy row also gets "Hide" through `<ContextMenu>` (right-click
  on desktop, long-press on native; docs/design.md §6, incidental row actions). Hidden rows leave
  the header count and tone and move to the "hidden" group, where each row has "Unhide". Persist
  hidden names per host (server id) in a small zustand store with `persist` and
  `createValidatedPersistStorage`, following `packages/app/src/stores/sidebar-order-store.ts`.
  Client-only for now: the desktop app and the phone keep separate lists.
- **Split view from wiring,** like `device-status/`: `mcp-status-strip-view.tsx` takes the model
  and callbacks and renders, `mcp-status-strip.tsx` wires `useMcpStatus`, the hidden store and the
  toast. Grouping, header copy choice and hide filtering live in the pure model
  (`mcp-status-strip-model.ts`), not in the view.

## Out of scope

Daemon or protocol changes. Syncing hidden servers across clients. Changing which failures are
terminal (`TERMINAL_FAILURE_REASONS`).

## Verification

- Unit: extend `mcp-status-strip-model.test.ts` and `mcp-status-copy.test.ts` for the groups,
  header copy (0 / 1 / many unhealthy, critical first), hide filtering, and second-line choice.
- Screenshot: add `mcp-status-strip-view.screenshot.browser.test.tsx` modelled on
  `components/inline-workspace-title-field.screenshot.browser.test.tsx`. Fixture mirrors the
  screenshot: `claude.ai Robinhood` (session-only connector), `figma` (needs-auth,
  `client_registration_refused`), `linear` and `notion` (needs-auth, `authorization_failed`,
  "Invalid refresh token"), `slack` (needs-auth, `client_not_registered`, with a remedy path),
  plus 9 connected servers. Capture at the desktop sidebar width (~320px) and at phone width
  (~390px): collapsed, expanded, expanded with one failure opened, and with the connected group
  open. Write PNGs to `docs/assets/mcp-status-strip-*.png`.
- Typecheck and lint the app package. Format the touched files.
