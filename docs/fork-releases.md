# Fork releases

How desktop builds ship from the fork, `funkmastert/paseo`. The upstream playbook in [release.md](release.md) still owns versions, tags, rollout, and retries. This doc covers only what differs on the fork.

## What the workflows do on a fork

- **Update feed.** Every desktop build bakes in the repo that runs the workflow (`-c.publish.owner/repo` in `desktop-release.yml`) as its update feed. `packages/desktop/electron-builder.yml` names the fork for local builds. If a fork build pointed at `getpaseo/paseo`, a Windows or Linux install would update itself to upstream Paseo.
- **Publishing.** Every release step writes to `github.repository` with the run's `GITHUB_TOKEN`, which cannot write to another repo. Nothing in the pipeline can publish to upstream's releases or feed.
- **Signing follows the secrets.** With all Apple or Azure secrets set (see [Signing](#signing)), a platform is signed. With none set, macOS is signed ad-hoc and Windows is unsigned. A partial set fails the build instead of shipping something half-signed.
- **Install steps on the release page.** For each unsigned platform, `finalize-rollout` appends [unsigned-macos.md](../.github/release-notes/unsigned-macos.md) or [unsigned-windows.md](../.github/release-notes/unsigned-windows.md) to the release body. Those two files are the only copy of the Gatekeeper and SmartScreen steps; link to them, don't restate them. Re-running Release Notes Sync overwrites the body and drops the section. Rebuild the release to put it back.
- **Skipped on forks.** Deploy App, Deploy Website, and Deploy Relay target upstream's Cloudflare account. Android APK Release builds on upstream's EAS project. All four check `github.repository == 'getpaseo/paseo'`, so a fork tag skips them.
- **Still runs on a `v*` tag.** Release Notes Sync copies the matching `CHANGELOG.md` entry into the fork release, or skips when there is none. Docker pushes `ghcr.io/funkmastert/paseo:<version>`, and `:latest` for a stable tag.

## Cutting a release

You need GitHub Actions enabled on the fork (it is, since 2026-09-27) and the commit you release to contain this workflow. The fork has never registered `desktop-release.yml`: `gh workflow list -R funkmastert/paseo --all` shows only CI, Docker and Nix, so step 1 returns HTTP 404. GitHub registers a workflow when an event runs it, and the first `v*` tag push (step 2) does. Making `multi-account-orchestrator` the fork's default branch may also register it, but that is untested.

1. **Dry run.** This builds every platform without creating a tag or a release. Each build launches the packaged app as a smoke test on macOS arm64 and x64, Windows x64, and Linux.

   ```bash
   gh workflow run desktop-release.yml -R funkmastert/paseo \
     --ref multi-account-orchestrator \
     -f tag=v0.8.0 -f checkout_ref=multi-account-orchestrator -f publish=false
   ```

   `tag` only sets the version here; it does not have to exist. Download the `desktop-macos-*`, `desktop-windows`, and `desktop-linux` artifacts from the run and install them.

2. **Release.** Tag the commit and push the tag to `origin`. Never push a tag to `upstream`.

   ```bash
   git tag v0.8.0 <commit>
   git push origin v0.8.0
   ```

   The tag must be `vX.Y.Z` (stable channel) or `vX.Y.Z-beta.N` (beta channel), and it sets the app version. Upstream's tags do not exist on the fork, so reusing upstream's version numbers is fine.

3. **Watch.** `gh run watch -R funkmastert/paseo`. The release stays a draft until every platform builds. To retry a failed platform, follow [Fixing a failed release build](release.md#fixing-a-failed-release-build).
4. **Rollout.** In-app updates reach users over 36 hours. To admit everyone now, run `gh workflow run desktop-rollout.yml -R funkmastert/paseo -f tag=v0.8.0 -f rollout_hours=0`.

A release has these assets:

| Platform | Files                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| macOS    | `Paseo-<v>-arm64.dmg`, `Paseo-<v>-x64.dmg`, and matching `.zip` files for the updater |
| Windows  | `Paseo-Setup-<v>-x64.exe`, `Paseo-Setup-<v>-arm64.exe`, and matching `.zip` files     |
| Linux    | AppImage, `.deb`, `.rpm`, `.tar.gz` (x64)                                             |
| All      | `latest*.yml` or `beta*.yml` update manifests                                         |

The app is named Bozeo, but the files keep upstream's `Paseo-` names.

## Unsigned builds

- **macOS.** Gatekeeper blocks the first launch until the user clicks **Open Anyway** in Privacy & Security. In-app updates fail: Squirrel.Mac only installs an update signed with the running app's identity, and an ad-hoc identity is unique to each build. Users update by downloading each new release.
- **Windows.** SmartScreen shows "Windows protected your PC" on every new version, because an unsigned file's reputation belongs to its hash. Smart App Control and managed-PC policy can block the installer outright. In-app updates install.

Unsigned macOS builds are signed ad-hoc rather than not at all. Skipping signing leaves Electron's linker signature, which no longer matches the modified bundle, and Gatekeeper then calls a downloaded app "damaged" with no **Open Anyway** option. The smoke test launches the app without quarantine, so it does not exercise Gatekeeper.

## Signing

Add the secrets under **Settings → Secrets and variables → Actions** on the fork. The next run signs that platform. Nothing else changes.

**macOS (Developer ID + notarization)**

| Secret                       | Value                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of the "Developer ID Application" certificate exported as `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password                                              |
| `APPLE_ID`                   | Apple Account email of the developer account                            |
| `APPLE_PASSWORD`             | An app-specific password for that account                               |
| `APPLE_TEAM_ID`              | The 10-character team ID                                                |

This needs a paid Apple Developer Program membership. Only its Account Holder can create a Developer ID Application certificate.

**Windows (Azure Artifact Signing)**

| Secret                                                      | Value                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An Entra app registration with the Artifact Signing Certificate Profile Signer role |
| `AZURE_SIGNING_ENDPOINT`                                    | The account's region endpoint, e.g. `https://eus.codesigning.azure.net/`            |
| `AZURE_SIGNING_ACCOUNT`                                     | The Artifact Signing account name                                                   |
| `AZURE_SIGNING_PROFILE`                                     | The certificate profile name                                                        |
| `AZURE_SIGNING_PUBLISHER`                                   | The certificate's subject CN, your validated legal name                             |

Artifact Signing needs a paid Azure subscription and identity validation. Individual developers must be in the USA or Canada. A traditional OV certificate would need a different hook. Its key has to live on a hardware token or cloud HSM, so it cannot be exported to a secret.

Neither signing path has run in CI yet. Treat the first signed run as a test: use the dry run above and check the result with `codesign -dv --verbose=2` on macOS or the file's **Digital Signatures** tab on Windows.
