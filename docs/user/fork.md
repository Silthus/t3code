# T3 Code (Fork) on a Mac

T3 Code (Fork) is the desktop app built from this fork's `main`. It installs
next to the official T3 Code app and runs at the same time, with its own data
in `~/.t3-fork`. The official app and its data in `~/.t3` stay untouched.

## Install and update

On an Apple Silicon Mac, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Silthus/t3code/main/scripts/fork/install-mac.sh | bash
```

This puts `T3 Code (Fork).app` in `/Applications`. Run the same command to
update. A running fork quits, updates, and opens again. Every green build of
fork `main` replaces the download, so the command always gets the newest
working build. **T3 Code (Fork) → About T3 Code (Fork)** shows the commit it
was built from.

The app is not signed with an Apple Developer ID. The installer downloads it
with `curl`, so macOS opens it without a Gatekeeper prompt. After an update,
macOS may ask once whether the app can use its "T3 Code (Fork) Safe Storage"
keychain item. Choose **Always Allow**.

To install a build you made yourself, point the installer at its zip:

```bash
T3CODE_FORK_DOWNLOAD_URL="file://$PWD/release/T3-Code-Fork-arm64.zip" bash scripts/fork/install-mac.sh
```

## Connect your remote machines once

The fork cannot read the official app's saved connections. Add each remote
machine again: open **Settings → Connections → Add environment**, choose
**SSH**, and enter the same host, for example `coder.<workspace>`. The fork
reuses the T3 Code server that already runs there, so all its threads show up.
See [Desktop-managed SSH](./remote-access.md#desktop-managed-ssh).

## What works differently

- **No automatic updates.** Run the install command again.
- **`t3code://` links open the official app.** Sign-in flows that return through
  a browser link, such as T3 Connect, do not reach the fork. Use SSH or a
  pairing link instead.
- **Its own data.** Local projects, threads, and settings live in `~/.t3-fork`.

To remove the fork, quit it and delete `/Applications/T3 Code (Fork).app`.
Delete `~/.t3-fork` too if you no longer want its data.
