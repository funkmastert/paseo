---
title: Share Builds To Tyler's Phone - Plan
type: feat
date: 2026-10-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Share Builds To Tyler's Phone - Plan

## Goal Capsule

- **Objective:** an agent that built a mobile app hands it to Tyler's phone remotely. The daemon hosts the build behind an unguessable, expiring https link on bozeo.ngrok.app and pushes Tyler a notification; tapping it installs the APK, or opens the iOS over-the-air install page.
- **Authority:** this plan, then `docs/notification-policy.md`, `docs/permissions.md`, `docs/disk-pressure.md`, `docs/resource-monitor.md` (disk brake), `CLAUDE.md`. Grounding: `~/bozeo-ops/briefs/share-builds-grounding.md` (local).
- **Execution profile:** one worker for U1–U4 in order; U5 (the public server, outside the repo) can run alongside.
- **Stop conditions:** stop and report if hosting would require the public site to run anything beyond static file serving, or if a push tap cannot open an https URL on a platform.
- **Tail ownership:** the worker commits locally and never pushes or restarts the 6767 daemon. The leader reviews, opens the PR, merges and deploys.

---

## Product Contract

### Problem Frame

Tyler is rarely home and his phone is not plugged in, so agents cannot install builds on it. Settled with Tyler on 2026-10-08: host on this Mac through bozeo.ngrok.app, notify by push, and support Android and iOS. iOS over-the-air install needs an ad-hoc signed IPA with his iPhone registered on the profile. That profile does not exist yet; Tyler will add it, and the mobile repo is not changed.

### Requirements

- R1. An agent tool takes a local `.apk` or `.ipa` the agent built and returns an https link that installs it.
- R2. Each shared build lives behind an unguessable token that expires after 3 days. Expired and evicted builds are deleted from disk.
- R3. Tyler receives a push naming the app, version and agent; tapping it opens the link in the phone's browser.
- R4. An `.ipa` gets a generated `manifest.plist` and a small install page with the `itms-services://` link. An `.apk` downloads with the Android package content type.
- R5. Sharing is bounded: a per-file size cap, total storage cap with oldest-first eviction, and refusal while the disk brake holds (free disk under the low line).
- R6. The public site stays static-only; the daemon never exposes an endpoint through the tunnel.
- R7. Agents know how to produce a shareable build: an Android debug APK, and an iOS ad-hoc IPA exported with an export-options file kept outside the company repo.

### Scope Boundaries

- No change to Wonderly company repos, signing, or the Apple developer account; Tyler adds the ad-hoc profile.
- No TestFlight or Play Store upload.
- No public listing page of builds; only per-build links.

---

## Planning Contract

### Key Technical Decisions

- KTD-1. Hosting: a second static root, `~/.paseo/public-web-shares/<token>/`, served by `~/bozeo-ops/public-web/server.mjs` under the `/b/<token>/` prefix with the same realpath confinement as its existing root. It sits outside the root that `publish.sh` swaps, so UI publishes never wipe it. Tokens are 128-bit random, URL-safe. (session-settled: user-directed — chosen over hosting on the Mac mini: reuse the existing tunnel.)
- KTD-2. Notification: push at level `alert` through `PushNotifications.send`, mirroring `finish-obligation-service.ts`, with a new optional `data.externalUrl`. The app's `notification-routing.ts` opens it with `openExternalUrl` on tap, on iOS, Android and web. (session-settled: user-directed — chosen over a link in chat only.)
- KTD-3. iOS: the daemon reads `CFBundleIdentifier`, `CFBundleShortVersionString` and the display name from the IPA's `Info.plist`, writes `manifest.plist` plus `index.html` beside it, and links to `itms-services://?action=download-manifest&url=<https manifest>`. Agents export ad-hoc IPAs with an export-options plist under `~/bozeo-ops/` or a temp dir, never committed to the company repo. (session-settled: user-directed — chosen over TestFlight and Android-only: Tyler will add the ad-hoc profile.)
- KTD-4. Tool safety follows `jev-file-state.ts`'s confinement: resolve, realpath, confine under the caller's cwd or its worktree, reject symlink and hard-link escapes, regular files only, extension `.apk` or `.ipa`. It then streams the copy, never buffering the file. Defaults: 600 MB per file, 3 GB total, 3-day expiry.
- KTD-5. Expiry and eviction live in a small daemon service with a sweep (hourly, and on each share) that deletes expired directories and evicts oldest-first over the total cap. The metadata file per share is the source of truth.

---

## Implementation Units

### U1. Share store and sweep

**Goal:** stored builds with tokens, metadata, expiry and caps.

**Requirements:** R2, R5; KTD-4, KTD-5.

**Files:** a new `packages/server/src/server/shared-builds/` (store, sweep, config) and tests; `persisted-config.ts` (`agents.sharedBuilds { enabled, maxFileMb, maxTotalMb, expiryHours }`).

**Approach:** write each build to `<root>/<token>/` with `share.json` (agentId, file name, platform, bytes, createdAt, expiresAt, app metadata). Writes are atomic: copy into a temp dir, then rename. The disk check comes from the shared free-disk read the disk brake uses.

**Test scenarios:**

- A share writes the file and metadata under a fresh token.
- Expired shares are deleted by the sweep.
- Over the total cap, the oldest is evicted.
- A file over the per-file cap is refused.
- Free disk under the low line refuses the share.
- A half-written share left by a crash is cleaned up.

**Verification:** targeted tests over a temp root.

### U2. iOS manifest and install page

**Goal:** an IPA becomes an installable OTA bundle.

**Requirements:** R4; KTD-3.

**Files:** `packages/server/src/server/shared-builds/ios-manifest.ts` and test.

**Approach:** read `Payload/*.app/Info.plist` from the IPA zip, binary or XML plist, without unpacking the whole archive. Generate `manifest.plist` (software-package URL, bundle-identifier, bundle-version, title) and a minimal `index.html` with the install link and the app name and version. An IPA without a readable Info.plist is refused with a clear message.

**Test scenarios:**

- A fixture IPA with a binary Info.plist yields the right manifest fields.
- An XML plist works too.
- A corrupt zip is refused.
- The manifest URL is the https share URL.

**Verification:** targeted tests with small fixture IPAs, fake identifiers only.

### U3. `share_build` agent tool and push

**Goal:** agents share a build in one call; Tyler gets the push.

**Requirements:** R1, R3; KTD-2, KTD-4.

**Files:** a new `packages/server/src/server/agent/tools/share-build-tools.ts` (registered where `device-lease-tools.ts` is), push wiring, tests; `packages/protocol` only if a push payload type needs the optional `externalUrl`, tagged COMPAT.

**Approach:** validate the path per KTD-4, store it (U1), generate the iOS bundle when needed (U2), and build the public URL from the configured `app.baseUrl` (https://bozeo.ngrok.app). Send the push with `data.externalUrl`, then return the URL, expiry and what Tyler will see. The tool description tells agents what to share, how to produce a debug APK or an ad-hoc IPA (KTD-3), and that sharing is refused while disk is low.

**Test scenarios:**

- A valid APK under the agent's cwd is shared, the URL is returned, and one push is sent with `externalUrl`.
- A path outside the cwd, a symlink escape, a directory or a `.zip` are refused.
- An IPA produces the install-page URL.
- The feature turned off refuses with a message.

**Verification:** targeted tests over a fake push sender and temp dirs.

### U4. Push tap opens the link (app)

**Goal:** tapping the push installs or opens the install page.

**Requirements:** R3; KTD-2.

**Files:** `packages/app/src/utils/notification-routing.ts` and its caller(s), tests.

**Approach:** when a notification carries `data.externalUrl` with https, tapping calls `openExternalUrl` instead of routing in-app, on iOS, Android and web. Any other scheme is ignored.

**Test scenarios:**

- A tap with an https `externalUrl` opens it.
- A non-https value falls back to normal routing.
- Notifications without it are unchanged.

**Verification:** targeted app tests.

### U5. Public server serves shares (outside the repo)

**Goal:** `/b/<token>/<file>` is served from the shares root, statically.

**Requirements:** R2, R4, R6; KTD-1.

**Files:** `~/bozeo-ops/public-web/server.mjs` (back it up first), its tests if present; not committed to the repo.

**Approach:**

- Add the second root behind the `/b/` prefix with realpath confinement.
- Serve `application/vnd.android.package-archive` for `.apk`, `application/octet-stream` for `.ipa` and `application/xml` for `.plist`. HTML is served as now.
- Return 404 for a missing token or one whose `share.json` has expired.
- No directory listing.
- Restart the LaunchAgent and verify it runs the new code (`docs`-style: the process start time after the file mtime).

**Test scenarios:**

- An existing share is served with the right content type.
- An expired one returns 404.
- `../` and symlink escapes return 404.
- The existing UI paths are unchanged.

**Verification:** curl against 127.0.0.1:6780 with a temp share.

### U6. Agent guidance

**Goal:** agents produce shareable builds without touching the company repo.

**Requirements:** R7; KTD-3.

**Files:** a new `docs/shared-builds.md` (and a row in the `CLAUDE.md` docs table); the tool description.

**Approach:** cover how to build a debug APK, how to export an ad-hoc IPA with an export-options plist kept outside the repo, what the link and push look like, the caps and expiry, and that iOS needs Tyler's ad-hoc profile.

**Test expectation:** none — docs only.

---

## Verification Contract

- Targeted vitest via `nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run <file> --bail=1 --maxWorkers=2`; check `uptime` first and wait while load1 is above 16; never a full suite, never a native build.
- `npm run build:server` / `build:client` before cross-package type errors; typecheck, lint and format.
- Never touch the live daemon on 6767 or write under `~/.paseo` except through tests' temp dirs. U5's LaunchAgent restart is the leader's step.

## Definition of Done

- R1–R7 met with tests; docs added.
- After deploy, the leader shares a real debug APK, receives the push on Tyler's phone, and the link downloads with the Android content type. An IPA path is verified with a fixture until Tyler's ad-hoc profile exists.
