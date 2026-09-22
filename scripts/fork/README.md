# T3 Code Fork

This is a local macOS app launcher for the current checkout. It uses the normal
desktop development runtime, with a separate app identity, T3 home, Electron
session directory, and secrets file. It does not use the live `~/.t3/userdata`
directory and it does not use the upstream desktop updater.

## Install

Run this from the repository root after dependencies and the normal desktop
build tools are available:

```sh
bun scripts/fork/install.ts install
```

The command creates `~/Applications/T3 Code Fork.app` and a mode `0600` secrets
file at `~/Library/Application Support/T3 Code Fork/secrets.env`. Add local
secrets to that file as `NAME=value` or `export NAME=value` lines. The file is
not copied to the repository.

## Launch

```sh
bun scripts/fork/install.ts launch
```

The app starts `bun run dev:desktop` from this checkout. The launcher waits for
the dev runner to select its ports, then starts Electron from the installed
fork app bundle. It enables the web app's bundled development mode, which
avoids loading the cold module graph through one custom-protocol request per
import. Output from the launcher, dev runner, and Electron is appended to
`~/Library/Application Support/T3 Code Fork/t3-home/userdata/logs/fork-launcher.log`.
Web changes use hot reload. Restart the fork after server or desktop main-process changes. The launcher waits for fresh build-success markers before it starts Electron.

The fork bundle does not register `t3code-dev` with macOS. That protocol is
only used inside its Electron process, so the fork cannot become the default
handler for another development install.

## Inspect

```sh
bun scripts/fork/install.ts inspect
```

This prints identity and path metadata. It does not print secret values.

## Uninstall

```sh
bun scripts/fork/install.ts uninstall
```

Only `~/Applications/T3 Code Fork.app` is removed. Runtime data is kept so a
later install can continue the fork session. Remove the displayed fork data
directory yourself only when that data is no longer needed.

## Sync the fork branch

The sync command refuses a dirty worktree and refuses to run unless the current
branch is `t3code/build-github-pr-monitor`. It fetches `main` from the `upstream` remote
and merges it. It never uses force, reset, checkout, or restore:

```sh
bun scripts/fork/install.ts sync
bun scripts/fork/install.ts sync --remote upstream
```

Set `T3CODE_FORK_BRANCH` to use another local fork branch. Create or select that
branch before running the command. Resolve merge conflicts manually before
launching the app.
