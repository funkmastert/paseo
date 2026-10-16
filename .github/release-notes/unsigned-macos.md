### Installing on macOS

This build is not signed with an Apple Developer ID or notarized, so macOS blocks the first launch.

1. Download the `.dmg` for your Mac: `arm64` for Apple silicon (M1 and later), `x64` for Intel.
2. Open the `.dmg` and drag **Bozeo** to **Applications**.
3. Open Bozeo. macOS says it could not verify the app. Click **Done**.
4. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the message about Bozeo. The button stays there for about an hour after the blocked launch.
5. Click **Open Anyway** in the dialog and enter your login password.

You only do this once. On macOS 13 or 14 you can instead Control-click Bozeo in Applications, choose **Open**, then click **Open**.

If macOS says Bozeo "is damaged and can't be opened", clear the download quarantine and open it again:

```sh
xattr -dr com.apple.quarantine /Applications/Bozeo.app
```

In-app updates can't install on an unsigned Mac build. To update, download the new `.dmg` from the Releases page and replace the app.
