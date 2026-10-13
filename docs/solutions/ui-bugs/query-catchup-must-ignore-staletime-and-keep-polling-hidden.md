---
title: A TanStack Query catch-up option that respects staleTime does not catch up, and a hidden window skips every poll tick
date: 2026-10-13
category: ui-bugs
module: provider-usage
problem_type: ui_bug
component: tooling
symptoms:
  - "a Claude account signed back in from a terminal is reported healthy by the daemon (provider.usage.list) within a second, but the desktop app's red account-problem banner stayed up for 15+ minutes"
  - "daemon.log's inboundSessionRequestTypesTop showed zero provider.usage.list.request for the whole stale window — nothing was going to clear the banner on its own"
  - "only a full window reload (Cmd+R) cleared the banner"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [tanstack-query, catch-up-on-focus, stale-time, background-poll, account-banner, electron]
---

# A TanStack Query catch-up option that respects staleTime does not catch up, and a hidden window skips every poll tick

## Problem

`useProviderUsage` (`packages/app/src/provider-usage/use-provider-usage.ts`) already had a `catchUpOnFocus` option meant to refetch when the window regains focus or the host reconnects, with a comment explaining exactly why that matters for a polled surface. It still wasn't enough: a fixed Claude account kept the desktop app's account-problem banner (`packages/app/src/account-alerts/account-alert-banner.tsx`) showing red for 15+ minutes after the daemon already reported it healthy.

## Symptoms

- Account signed back in from a terminal; daemon-side health flips within a second, but the app's banner stays red.
- No `provider.usage.list.request` on the websocket for the entire stale window.
- A manual reload fixes it instantly, because `refetchOnMount: true` (`use-provider-usage.ts:74`) always fetches fresh on mount.

## What Didn't Work

The hook already passed `catchUpOnFocus` straight into `refetchOnWindowFocus` and `refetchOnReconnect` (`use-provider-usage.ts:76-77`). That looked like the fix already in place, but TanStack Query 5.90 gates both of those behind `staleTime` (5 minutes here, `PROVIDER_USAGE_STALE_TIME_MS`) when the option is a bare `true`: a refocus or reconnect within 5 minutes of the last fetch refetches nothing. An Electron window that was merely occluded, minimized, or on another Space the whole time easily stays inside that window.

Even with focus/reconnect fixed, `refetchInterval` itself skips every tick while `focusManager.isFocused()` is false — which TanStack Query derives from `document.visibilityState === "hidden"`. A banner polling every 15s while occluded never actually polls.

## Solution

`catchUpOnFocus` became a tri-state option matching TanStack Query's own `refetchOnWindowFocus`/`refetchOnReconnect` type (`boolean | "always"`) instead of a bespoke resolver function, and the banner's poll opts into the two settings that bypass the gaps:

```ts
// use-provider-usage.ts
catchUpOnFocus?: boolean | "always";        // "always" ignores staleTime
refetchIntervalInBackground?: boolean;       // keep polling while hidden
networkMode?: "online" | "always" | "offlineFirst";

const focusRefetchMode = options.catchUpOnFocus ?? false;
// ...
refetchOnReconnect: focusRefetchMode,
refetchOnWindowFocus: focusRefetchMode,
refetchIntervalInBackground: options.refetchIntervalInBackground ?? false,
```

```ts
// account-alert-banner.tsx — HostAlertSource
const { view } = useProviderUsage(serverId, {
  refetchInterval: pollFast ? FAST_REFETCH_INTERVAL_MS : DEFAULT_REFETCH_INTERVAL_MS, // 15_000 while a problem stands
  catchUpOnFocus: "always",
  refetchIntervalInBackground: true,
  // The daemon serves this from its own cache over a WebSocket this hook does not
  // share with the browser's connectivity check, so navigator.onLine must not pause it.
  networkMode: "always",
});
```

`networkMode: "always"` matters independently of focus: the query rides the daemon's own WebSocket, not `fetch`, so TanStack Query's default `navigator.onLine`-based pausing (`networkMode: "online"`) is the wrong signal for this transport.

## Why This Works

- `catchUpOnFocus: "always"` passes `"always"` straight through to `refetchOnWindowFocus`/`refetchOnReconnect`, which tells TanStack Query to refetch on focus/reconnect even when the current data isn't stale yet — the staleTime gate no longer blocks the catch-up fetch that was the whole point of the option.
- `refetchIntervalInBackground: true` keeps `refetchInterval` firing on its own schedule regardless of `document.visibilityState`, so an occluded/minimized/backgrounded window still polls and clears a resolved problem without needing focus at all.
- `networkMode: "always"` removes the unrelated online/offline gate that has nothing to do with this transport.

Any one of the three alone was not enough — the bug needed all three options to actually agree to fetch during every state the window can be in.

## Prevention

- When a polled TanStack Query surface claims to "catch up on focus," verify the claim against `staleTime`, not just that `refetchOnWindowFocus`/`refetchOnReconnect` is `true` — a bare `true` is `staleTime`-gated and silently does nothing for a poll with a staleTime of minutes.
- Any query that must stay current while the window is hidden (occluded, minimized, another Space) needs `refetchIntervalInBackground: true` explicitly; `refetchInterval` does not poll a hidden document by default.
- A query driven by a transport other than `fetch` (a daemon WebSocket, a local socket) needs `networkMode: "always"` — the TanStack Query default assumes `navigator.onLine` reflects the transport's own connectivity, which is false for sockets the browser's online/offline events don't track.
- `docs/design.md` §11 (States) now documents that the account alert banner passes its own `icon` (`AlertTriangle`) to `<Alert>` rather than relying on the `error` variant's default icon, because `error`'s default read as a close button. When a status `<Alert>` is non-dismissible or close-adjacent, check that its icon can't be mistaken for a control — add a real `onDismiss` close button instead of letting a status glyph imply one.
