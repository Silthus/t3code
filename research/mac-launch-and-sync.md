# Launching the fork on the Mac and tracking upstream

Research for [Silthus/t3code#9](https://github.com/Silthus/t3code/issues/9), part of map [#6](https://github.com/Silthus/t3code/issues/6). Code references are to fork `main` at `6c8fed35d`, which is the same as upstream `main`.

## Recommendation in one paragraph

Ship the fork as a **second, side-by-side desktop app called "T3 Code (Fork)"**. It has its own bundle id, Electron userData directory, and T3 home (`~/.t3-fork`), and no update feed. A fork-only GitHub Actions workflow builds it unsigned on a GitHub-hosted Apple Silicon runner. Each green build of fork `main` replaces one rolling prerelease. Michael installs and updates with one command:
`curl -fsSL https://raw.githubusercontent.com/Silthus/t3code/main/scripts/fork/install-mac.sh | bash`.

He re-adds his devboxes once in the fork's Settings → Connections (SSH host `coder.<workspace>`). The SSH flow reuses the official server already running on each box, so the PR-linked threads show up unchanged.

A second fork-only workflow, `fork-sync-upstream.yml`, merges `pingdotgg/t3code` `main` into fork `main` every 6 hours. When the merge conflicts, it opens a single issue and the run fails. A push that merges cleanly triggers the Mac build, so only builds that pass ever reach the Mac.

## 1. How the official desktop app identifies itself

The official app is identified by these settings. Each one decides whether two apps can run side by side.

| Concern | Where | Official value | Conflict if the fork reuses it |
| --- | --- | --- | --- |
| Bundle id | `scripts/build-desktop-artifact.ts:57` `DESKTOP_APP_ID`, used at `:2642` | `com.t3tools.t3code` | macOS sees one app. The installer and Squirrel.Mac target the same bundle. |
| Product name / `.app` name | `apps/desktop/package.json` `productName`; `resolveDesktopProductName` `scripts/build-desktop-artifact.ts:2616` | `T3 Code (Alpha)` (`T3 Code (Nightly)` for nightly versions) | Installing to `/Applications` overwrites the official app. |
| Runtime app name (`app.setName`) | `resolveDesktopAppBranding` `apps/desktop/src/app/DesktopEnvironment.ts:109`, applied at `DesktopAppIdentity.ts:123` | `T3 Code (Alpha)` | Electron `safeStorage` uses the keychain item "<app name> Safe Storage". Sharing the name hits the official app's key and triggers keychain prompts. |
| Electron userData, which scopes the **single-instance lock** | `DesktopEnvironment.ts:191-192`; `DesktopAppIdentity.resolveUserDataPath` `:48-66`; set before Clerk takes the lock, `DesktopClerk.ts:97-104` | `~/Library/Application Support/t3code`. The legacy `T3 Code (Alpha)` is used if that directory exists. | Both apps would fight over one lock, so the second app to launch exits. This holds even with a new bundle id, because the legacy-path check would find the official app's directory. |
| T3 home / state dir | `resolveDesktopBaseDir` and `resolveDesktopStateDir` in `apps/desktop/src/app/DesktopStatePaths.ts`. `T3CODE_HOME` overrides (`DesktopConfig.ts:40`). | `~/.t3/userdata` (`~/.t3/dev` in development) | Two bundled backends would write to the live `state.sqlite` at once. This breaks AGENTS.md rule 2. |
| Local backend port | `DEFAULT_DESKTOP_BACKEND_PORT = 3773`, scanning upward, `apps/desktop/src/app/DesktopApp.ts:36,84` | first free port from 3773 | No conflict. The second app picks the next free port. |
| URL schemes | `mac.protocols` `scripts/build-desktop-artifact.ts:2696-2701`; `open-url` handled by the Clerk bridge `DesktopClerk.ts:191` | `t3code`, `t3code-dev` | LaunchServices sends `t3code://` callbacks (Clerk/T3 Connect sign-in) to only one app. |
| Update feed | `resolveGitHubPublishConfig` `scripts/build-desktop-artifact.ts:2538-2562`: `T3CODE_DESKTOP_UPDATE_REPOSITORY`, else `GITHUB_REPOSITORY`. No feed means no `app-update.yml`, and the updater is disabled (`DesktopUpdates.ts:252-266`). | `pingdotgg/t3code` releases | In Actions on the fork, `GITHUB_REPOSITORY=Silthus/t3code`, so the build would poll the fork's releases. |

Two consequences:

- A fork build that only changes the bundle id still shares the official userData, lock, keychain name, and `~/.t3`. Every row above has to change together.
- The official updater only ever replaces its own bundle. A fork app with a different bundle id and `.app` name is never touched by it.

## 2. Where remote environments and threads live

- Saved connections are stored in `<stateDir>/connection-catalog.json` (`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:387`). The legacy store was `saved-environments.json` (`DesktopEnvironment.ts:215`). Both files sit under the **T3 home**, not under Electron userData, and both are **encrypted with Electron `safeStorage`** (`DesktopConnectionCatalogStore.ts:402-428,483-497`).
- On macOS the `safeStorage` key is a keychain item per app name, so a second app cannot decrypt a copy of the file. The source code never names the item; this behavior comes from Electron.
- Conclusion: **the fork cannot reuse the official app's saved environments.** Michael re-adds them once. For SSH devboxes this costs nothing, because the connection is just a host (`coder.<workspace>`) and the desktop app pairs automatically.
- Threads live on each environment's server. The client stores none, so once the fork connects to a devbox, all its threads, including PR-linked ones, show up.

How SSH connects (`packages/ssh/src/tunnel.ts`):

1. The runner always makes sure that `~/.t3/runtime/versions/<archiveVersion>` exists on the remote first. It downloads `t3-<version>-<platform>-<arch>.tar.gz` and `SHA256SUMS` from `https://github.com/pingdotgg/t3code/releases/download/v<version>/` (`:444-457,505-540`; `packages/shared/src/cliRelease.ts:8`).
2. Next it reads `~/.t3/userdata/server-runtime.json`. If a live server is listening on a loopback origin, the runner reuses it as `external` (`:607-670`). That is the service-launched official server on Michael's boxes.
3. Only when no server is running does it launch its own server, using that archive.

`archiveVersion` is the desktop app's own version (`apps/desktop/src/main.ts:91-101`) and must be an exact SemVer (`tunnel.ts:782-802`). This leads to a hard constraint:

> **The fork build must carry a version that exists as an upstream release.** A `-fork.N` suffix would make every SSH connect fail at the download step. Build with the `apps/desktop/package.json` version as is. Upstream's finalize job keeps it at the latest stable release, which is `0.0.44` today. Identify fork builds by the commit hash, which the About panel already shows (`DesktopAppIdentity.ts:96-117`).

## 3. What happens to remote servers when the fork connects

- **Nothing happens automatically.** Server updates go through `server.updateServer` (`packages/contracts/src/rpc.ts:386-387,610-621`) and only start when the user clicks a button (`apps/web/src/components/ServerUpdateAction.tsx:54-69`).
- The version sent is the **client's own version** (`ChatView.tsx:2799`, `ConnectionsSettings.tsx:1607`).
- The banner appears only when the server is *older* than the client (`apps/web/src/versionSkew.ts:55-85`). It is advisory and can be dismissed.
- When a devbox service runs `0.0.42` and the fork reports `0.0.44`, the fork shows the banner. Clicking **Update** installs **official** `t3@0.0.44` from `pingdotgg/t3code` releases through the service launcher, with a trial run and rollback (`apps/server/src/cloud/selfUpdate.ts:189-333`, `docs/internals/server-updates.md`).
- Fork code never reaches a devbox. Fork-only server features, such as the triage GitHub data, therefore run only in the Mac's bundled local backend. This matches the open question in map #6.
- Hard block: the client refuses servers whose `orchestrationProtocolVersion` differs from its own, which is `1` (`packages/client-runtime/src/connection/compatibility.ts:9-23`, `packages/contracts/src/environment.ts:13`). If upstream `main` ever raises the protocol before a stable release, the fork will refuse the devboxes. Updating them to the fork's stable version would not help, because that release still has the old protocol. Fix: move the boxes to the matching nightly with `t3 service update` / `npx t3@nightly`. The case is rare, but the sync issue should mention it.
- The fork's own local backend is "desktop-managed". An update request against it fails cleanly, because the fork has no update feed (`selfUpdate.ts:199-205`).

## 4. Launch options compared

| | (a) CI-built unsigned app (**recommended**) | (b) Local build on the Mac | (c) Fork web client |
| --- | --- | --- | --- |
| Daily effort | One command to install or update | Clone, Rust, Xcode CLT, `vp i`, then `vp run dist:desktop:artifact` (about 10-20 min per update) | Needs a fork server running somewhere (`vp run dev --share` on a devbox) |
| Coexists with official app | Yes, with the fork identity (section 5) | Yes, with the same identity code | Yes, it is a browser tab |
| Official updater | Never touches it (different bundle) | Same | n/a |
| Devbox threads | Re-add SSH hosts once; reuses running official servers | Same | Pair each box by URL; no SSH from a browser |
| Fork server features (triage) | Bundled local backend | Same | Only while the dev server runs |
| Gatekeeper | `curl` downloads get no quarantine flag, so an ad hoc–signed arm64 app runs. The script strips quarantine anyway. | Same, since the build is local | n/a |
| Breakage reaching the Mac | Only green builds are published | Whatever is checked out | Whatever is checked out |

(b) remains the fallback when Actions is unavailable. It uses the same identity code, and the install script takes the resulting zip: `install-mac.sh --from <zip>`. (c) stays the development loop on devboxes, not the daily driver.

**Replacing the official app instead of running alongside it** would mean keeping the official identity and installing over `/Applications/T3 Code (Alpha).app`. That reuses saved environments and needs no re-pairing. Rejected, because:

- the fork's backend would run upstream-`main` migrations against the live `~/.t3/userdata` database, with no way back to the official app;
- it removes the safety net of a working official app.

Choose it only if re-adding devboxes turns out to be painful.

The **prior attempt** on `t3code/build-github-pr-monitor` (`scripts/fork/install.ts`) wrapped `bun run dev:desktop` from a checkout on the Mac inside a `.app`. It was isolated correctly, but the Mac needed a full toolchain and checkout, it ran a dev server for daily use, and it waited for build-marker files. It also needed its own secrets file and a one-time history copy. Its identity idea is right; the launch mechanism is too heavy.

## 5. Implementation spec for the launch path

**Fork identity, opt-in at build time** so that upstream tests and code paths stay unchanged:

1. `apps/desktop/src/fork/forkDesktopIdentity.ts` (new) holds the values:
   - display/product name `T3 Code (Fork)`
   - bundle id `com.silthus.t3code.fork`
   - userData dir name `t3code-fork`, with the legacy dir name also `t3code-fork`
   - default T3 home `~/.t3-fork`
   - artifact name `T3-Code-Fork-${arch}.${ext}`
2. `apps/desktop/vite.config.ts` defines `__T3CODE_BUILD_DESKTOP_IDENTITY__` from `T3CODE_DESKTOP_IDENTITY` (`"fork"` or empty). It follows the existing `__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__` pattern at `:17-21`.
3. Hook lines in `apps/desktop/src/app/DesktopEnvironment.ts` set `displayName`/`branding`, `userDataDirName`, and `legacyUserDataDirName` when the identity is fork and the build is not a development build.
4. A hook line in `apps/desktop/src/app/DesktopStatePaths.ts` makes `resolveDesktopBaseDir` default to `.t3-fork`. `T3CODE_HOME` still wins, and the state dir stays `<home>/userdata`.
5. Hook lines in `scripts/build-desktop-artifact.ts` (`createBuildConfig`, `:2622-2710`), when `T3CODE_DESKTOP_IDENTITY=fork`:
   - use the fork `appId`, `productName`, and `artifactName`;
   - **omit `mac.protocols`**, so the fork never captures `t3code://`. T3 Connect/Clerk deep-link sign-in is therefore unsupported in the fork. Michael uses SSH, so this is acceptable;
   - **skip the publish config**, so there is no `app-update.yml` and the updater is disabled. Today `T3CODE_DESKTOP_UPDATE_REPOSITORY=none` already has this effect by accident (`:2552-2553`), but an explicit fork branch is clearer.
6. Tests in `apps/desktop/src/fork/*.test.ts` cover the identity resolution: paths, names, and the T3 home default. The build-config branch is tested from the outside through `createBuildConfig`.

**Workflow `.github/workflows/fork-desktop-mac.yml`** (new, fork-only):

- `on: push: branches: [main]` plus `workflow_dispatch`, with `concurrency: fork-desktop-mac` and `cancel-in-progress: true`.
- `runs-on: macos-15` (GitHub-hosted Apple Silicon, free for public repos). Upstream's `blacksmith-*` runners do not exist for the fork.
- Steps follow `desktop-macos-preview.yml` and `release-desktop.yml`:
  1. sparse checkout without `.repos/`
  2. `voidzero-dev/setup-vp`
  3. `dtolnay/rust-toolchain` with `aarch64-apple-darwin`
  4. `vp install`
  5. `cp .env.example .env`
  6. `T3CODE_DESKTOP_IDENTITY=fork vp run build:desktop`
  7. `T3CODE_DESKTOP_IDENTITY=fork vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --skip-build`
- No `--signed`. With no signing secrets, `CSC_IDENTITY_AUTO_DISCOVERY=false` (`scripts/build-desktop-artifact.ts:3776-3783`), and the release workflow already degrades the same way (`release-desktop.yml:416-434`). **No secrets are required.**
- Publish: create the prerelease `fork-desktop-latest` if it is missing, then run `gh release upload fork-desktop-latest release/*.zip --clobber`. Set the release notes to the commit SHA and upstream base. This needs `permissions: contents: write`.
- On failure, open or update one issue labeled `fork-build-broken`, and close it on the next green build.

**Script `scripts/fork/install-mac.sh`** (new):

1. Download `T3-Code-Fork-arm64.zip` from `releases/download/fork-desktop-latest/` with `curl`.
2. Quit the running fork politely: `osascript -e 'quit app "T3 Code (Fork)"'`. Never kill by pattern.
3. Unpack with `ditto -x -k` into a temp dir, then replace `/Applications/T3 Code (Fork).app`.
4. Run `xattr -dr com.apple.quarantine`, then `open` the app.
5. Support `--from <zip>` for option (b).

**Known friction:** every ad hoc–signed rebuild has a new code signature. On first launch after an update, macOS may ask to allow access to the "T3 Code (Fork) Safe Storage" keychain item; choose Always Allow. Signing with a stable self-signed certificate would remove the prompt, but it is not needed now.

**First run, as Michael:** run the install command, then go to Settings → Connections → Add environment → SSH and enter `coder.<workspace>` for each devbox. Provider sign-in stays on the devboxes.

## 6. Upstream sync

Facts that shape the design:

- GitHub keeps a fork's workflows dormant until the owner clicks **"I understand my workflows, go ahead and enable them"** in the Actions tab. This matches the fork: `actions/permissions` reports `enabled: true`, 18 workflows report `active`, and there have been **0 runs ever**.
- When a public repository is forked, its scheduled workflows are disabled by default ([GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)). Whether a REST call can replace the button is disputed ([community #104281](https://github.com/orgs/community/discussions/104281)), so plan for the click.
- After that click, every upstream workflow becomes live. These include `release.yml` (cron `8,38 * * * *`, publishing), `ci.yml` (on push to `main`), and deploy/mobile workflows. All of them target `blacksmith-*` runners or secrets the fork lacks, so they must be disabled first.
- A push made with `GITHUB_TOKEN` cannot change files under `.github/workflows/`, and it does not trigger other workflows. Upstream edits its workflows often, so the sync job needs a **fine-grained PAT** stored as `FORK_SYNC_TOKEN`, scoped to `Silthus/t3code` with Contents read/write and Workflows read/write. The REST [merge-upstream](https://docs.github.com/en/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository) endpoint would work too: 200 with `merge_type` set to `merge`, `fast-forward`, or `none`; 409 on conflict. But it does not report which files conflict, so use git instead.

**Workflow `.github/workflows/fork-sync-upstream.yml`** (new):

- Trigger on `schedule: "23 */6 * * *"` plus `workflow_dispatch`, with `concurrency: fork-sync-upstream` and `cancel-in-progress: false`.
- Permissions: `contents: write`, `issues: write`, `actions: write`.
- Steps:
  1. Check out `main` with `token: ${{ secrets.FORK_SYNC_TOKEN }}` and `fetch-depth: 0`, sparse without `.repos/`.
  2. `git remote add upstream https://github.com/pingdotgg/t3code.git && git fetch --no-tags upstream main`.
  3. If `git merge-base --is-ancestor upstream/main HEAD`, there is nothing to do. Close any open `upstream-sync-conflict` issue, then exit.
  4. Run `git merge --no-edit upstream/main`.
     - **Clean merge:** `git push origin HEAD:main`. A rejection means `main` moved during the run; the job fails and the next run retries. The PAT push triggers `fork-desktop-mac.yml`. Close any open conflict issue with a comment linking the merge commit.
     - **Conflict:** collect `git diff --name-only --diff-filter=U`, run `git merge --abort`, and open one issue labeled `upstream-sync-conflict` or update the open one. The issue lists the upstream SHA, the conflicting files, and the local fix: `git fetch upstream main && git merge upstream/main`, resolve, push. Then exit 1 so the run shows red.
  5. Always disable every workflow whose path does not start with `.github/workflows/fork-`, using `gh workflow list --all --json id,path,state` and then `gh workflow disable`. This also handles new workflows that upstream adds later. The disabled state is stored per workflow and survives merges.
- Without the PAT, the job should fail with an issue that says so, instead of pushing a partial merge.

Failure handling, summarized:

| Failure | Handling |
| --- | --- |
| Conflict | One deduplicated issue, red run, `main` untouched |
| Race on push | Red run, retried in 6 hours |
| Code that merges cleanly but breaks the build | The Mac build fails, opens `fork-build-broken`, and the rolling release keeps the last good build |
| Missing token | Issue plus red run |
| Upstream protocol bump | Mentioned in the conflict/build issue template (section 3) |
| Scheduled workflows disabled after 60 days of inactivity | Does not happen while the sync keeps pushing |

## One-time steps only Michael can do

1. Click **Enable workflows** in the fork's Actions tab. The implement ticket first disables the upstream workflows through the API, or right after the click.
2. Create the fine-grained PAT and save it as the repository secret `FORK_SYNC_TOKEN`.
3. On the Mac: run the install command and re-add each devbox over SSH.

## Sources

- Repository code at `6c8fed35d`, cited inline.
- `docs/operations/release.md` (desktop auto-update notes; unsigned builds) and `docs/operations/development.md` (desktop artifacts).
- Upstream releases: `gh release list -R pingdotgg/t3code`. The latest stable is `v0.0.45`, with `t3-0.0.45-darwin-arm64.tar.gz` and `SHA256SUMS` assets.
- Fork state: `gh api repos/Silthus/t3code/actions/permissions`, `.../actions/workflows`, `.../actions/runs` (total_count 0).
- GitHub docs: [Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), [Sync a fork branch with the upstream repository](https://docs.github.com/en/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository), [github/docs#15761](https://github.com/github/docs/issues/15761) (the "I understand my workflows" screen), [community discussion #104281](https://github.com/orgs/community/discussions/104281) (no API for the fork enable button).
- Electron `safeStorage` (macOS keychain item per app name): Electron's documented behavior; the repository does not name the item.
