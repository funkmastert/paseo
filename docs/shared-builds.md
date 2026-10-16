# Shared builds

An agent that built a mobile app hands it to Tyler's phone with the `share_build` tool. The daemon copies the build behind an unguessable https link that expires, and pushes Tyler a notification. Tapping it downloads the APK, or opens the iPhone install page. Tyler is rarely beside the Mac, so nothing here needs the phone plugged in.

## The flow

1. The agent calls `share_build` with a `.apk` or `.ipa` it built (`packages/server/src/server/agent/tools/share-build-tools.ts`).
2. The daemon checks the path, copies the file into `$PASEO_HOME/public-web-shares/<token>/` with a `share.json` beside it (`packages/server/src/server/shared-builds/shared-build-store.ts`), and for an IPA writes `manifest.plist` and `index.html` (`shared-builds/ios-manifest.ts`).
3. The public static site serves the share at `<app.baseUrl>/b/<token>/`.
4. Tyler gets an `alert` push whose `data.externalUrl` is the APK, or the IPA's install page. The app opens that link in the browser on tap (`packages/app/src/utils/notification-routing.ts`).

The tool returns the link, its expiry and the push text, so the agent can also give Tyler the link in chat.

## Making a shareable build

The company repos are never changed for this; anything a build needs lives outside them.

- **Android:** `./gradlew :app:assembleDebug`, then share `app/build/outputs/apk/debug/app-debug.apk`. Only a debug APK can be built locally: the release signing key lives in CI. An AAB can't be installed from a browser and is refused.
- **iPhone:** archive with `xcodebuild archive`, then `xcodebuild -exportArchive -exportOptionsPlist <plist>` with an export-options plist whose `method` is `release-testing` (`ad-hoc` before Xcode 15.3). Keep that plist in a temp directory or under `~/bozeo-ops/`, never in the repo. The IPA installs only on an iPhone registered on the ad-hoc provisioning profile; Tyler adds his iPhone to it.

## What Tyler sees

The push reads `Android build ready` or `iPhone build ready`, then the app, its version, the agent's title and the agent's note.

- **Android:** the tap opens the APK URL in the default browser, which downloads it with the Android package content type. The browser needs Install unknown apps once (Settings, Apps, Special app access).
- **iPhone:** the tap opens the install page; its Install button is an `itms-services://` link to the manifest. iOS honours it only in Safari, so Safari must be the default browser or the page opened there.
- **An app without this change** treats the push as an agent push and opens the agent, whose `share_build` result carries the link.

## Hosting

The public site is `~/bozeo-ops/public-web/server.mjs`, a static file server behind the ngrok tunnel run by the `sh.bozeo.public-web` LaunchAgent. `ops/public-web/server.mjs` is its vendored copy: edit the live file, then copy it back ([ops/README.md](../ops/README.md)). It serves `/b/<token>/<file>` from `~/.paseo/public-web-shares`, a sibling of the web UI root, because `publish.sh` replaces the UI root on every publish. The daemon exposes nothing through the tunnel; it writes files and the site reads them.

`share.json` is the contract between the two. The site serves a file only when the share's `share.json` names the same token and its `expiresAt` is in the future, so an expired link is a 404 before the daemon's sweep deletes it. It never serves `share.json` or a dotfile, never lists a directory, sends share responses with a CSP that allows only the install page's inline style, and confines every file to the share's own directory after realpath, as it does for the UI root. A token is 128 random bits in base64url, 22 characters, and is the only thing between a build and anyone who sees the link.

| File             | Content type                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `.apk`           | `application/vnd.android.package-archive`, sent as an attachment |
| `.ipa`           | `application/octet-stream`                                       |
| `manifest.plist` | `application/xml`                                                |
| `index.html`     | `text/html`                                                      |

A share goes live in one rename of its temp directory (`.tmp-<token>`), so the site never sees one without its record.

`ops/public-web/server.test.mjs` pins this contract and runs in CI: it starts the server with `BOZEO_PUBLIC_WEB_PORT=0`, `BOZEO_PUBLIC_WEB_ROOT` and `BOZEO_PUBLIC_WEB_SHARES` pointed at temp roots, and `BOZEO_PUBLIC_WEB_TUNNEL=0` (no tunnel, no :80 redirect). Run a manual copy the same way; without them a second copy exits on the busy port 6780. A request to port 0 goes to port 80, the live redirect, so read the bound port from the `listening` log line.

## Limits

`agents.sharedBuilds` in `config.json`, re-read on every share and sweep. The public URL is `PASEO_APP_BASE_URL`, else `app.baseUrl`, as for the daemon. It must be https and must not be the shipped default, `https://app.paseo.sh`, which serves no `/b/`; otherwise every share is refused and says why.

| Key           | Default | What it does                                                 |
| ------------- | ------- | ------------------------------------------------------------ |
| `enabled`     | `true`  | Off, `share_build` refuses.                                  |
| `maxFileMb`   | `600`   | A bigger build is refused before anything is copied.         |
| `maxTotalMb`  | `3072`  | Before a share, the oldest shares are deleted until it fits. |
| `expiryHours` | `72`    | How long a link works. Expired shares are deleted from disk. |

A share is also refused while it would leave free disk under the disk-low line, `agents.remediation.disk.lowFreeGB` (20 GB by default, [disk-pressure.md](disk-pressure.md)). Free disk is read once per share by `shared-builds/free-disk.ts`.

The daemon sweeps at startup, hourly, and once a share's copy has passed its checks, just before it goes live. A sweep deletes expired shares, temp directories and token-shaped entries without a readable `share.json` (what a crash leaves), then evicts oldest-first over the total cap. A share refused after its copy evicts nothing. The sweep leaves anything else in the root alone. Shares and sweeps run one at a time, and the copy stops at the size the disk check allowed for, so a build still being written is refused.

## The path an agent may share

The path is confined the way the JEV file tools confine theirs ([jev.md](jev.md)): resolved against the caller's cwd, realpathed, and inside that cwd or its git worktree. A cwd that is the filesystem root, the home directory or an ancestor of it, or the worktrees root is refused, and a git worktree like that doesn't widen the cwd. Only agents get the tool: without a caller there is no cwd. It must be a regular `.apk` or `.ipa` with one link, judged on the real path, so a symlink out of the cwd or onto another file type is refused. The copy is streamed from a handle opened without following symlinks, and the file's identity is checked again at open.

An APK must be a zip with a root `AndroidManifest.xml`; its package and version are read from the compiled manifest for the push. An IPA must carry `Payload/<App>.app/Info.plist` with a bundle identifier and a version, which the manifest needs.

## The push

`alert`: it needs Tyler soon, and nothing is lost if he waits ([notification-policy.md](notification-policy.md)). The dedupe key is the build's SHA-256, so sharing the same bytes twice within an hour pushes once; the second share still gets its own link.

The tool asks the notify policy what it will do before sending and reports it as `push.outcome`: `sent`, `folded` (the same build was pushed within the hour), `digest`, `logged`, `no-device`, `no-sender`, `failed`, or `unconfirmed` when the policy can't be asked. Anything but `sent` tells the agent to give Tyler the link itself.
