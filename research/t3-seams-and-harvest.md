# Reusable T3 Code seams and what to harvest from prior attempts

Ticket: [Silthus/t3code#8](https://github.com/Silthus/t3code/issues/8). Map: [#6](https://github.com/Silthus/t3code/issues/6).
Base: `origin/main` at `6c8fed35d`. Line numbers refer to that commit.

Bottom line: the Triage view needs one new fork service and almost no upstream edits. The service lists every open PR the viewer authored with a single GraphQL search (about 4–5 s and 27 points for 34 PRs, measured), applies the `audit-prs` deterministic rules, and judges risk through `TextGeneration` with one added method. Links from a PR to its threads already work when you fan out across environments. The prior fork branch is useful for its desktop launcher and a few classifier rules. Most of the rest was excess machinery.

## 1. Answers to the open gaps

### (a) Text generation

The salvaged answer still holds; see Appendix B. Add one `generateJudgement({ cwd, prompt, outputSchema, modelSelection })` method to `TextGeneration` and forward it to each provider's private `run*Json`. The triage service limits concurrency itself, because `textGeneration/` has no semaphore.

### (b) Cross-environment PR to thread links. Both gaps are now closed.

- **Which environment the detail panel asks.** `PullRequestDetailPanel` passes its own `environmentId` prop to all three `PullRequestThreadLinks` call sites (`:1660`, `:1853`, `:2025`). The prop has two sources:
  - On the PR page (`_chat.pull-requests.tsx:2133`) it is `panelEnvironmentId` (`:512`). That is the open tab's `renderedPullRequestSurface.environmentId`, which is the server the row was listed from. A deep link falls back to `selectedProject.environmentId`.
  - In a chat thread (`ChatView.tsx:9592`) it is `activeThread.environmentId`.
  - So linked threads are always read from one server: the one that listed the row. Threads on any other server stay invisible.
- **How lists merge.** `createMergedEnvironmentQuery` (`apps/web/src/state/pullRequests.ts:203`) is an `Atom.family` keyed by `JSON.stringify(targets)`. It reads one per-environment atom per target and returns `values` in target order. Each environment's failure is recorded but does not stop the others (the list is a union). `usePullRequestList` (`:291`) passes `values` to `mergePullRequestLists` (`pullRequestList.logic.ts:703`). That function concatenates entries tagged with `environmentId`, keys viewers by `"<env> <host>"`, merges providers by host, and sorts by `updatedAt` desc. It does not de-duplicate: de-duplication happens before the request.
- **Where de-duplication happens.** `assignProjectsToEnvironments` (`pullRequestProjectAssignment.logic.ts:28`) picks one owner per `repositoryIdentity.canonicalKey`. The owner is the preferred environment (`queryEnvironmentIds[0]`) if that environment has the repo, otherwise the lowest-ranked one. Projects with no identity are never de-duplicated. The route (`_chat.pull-requests.tsx:637-662`) then sends each environment `projectIds` only when its assigned set is smaller than everything it holds. An environment with nothing assigned is not read at all.
- **Consequence for Triage.** The Triage list does not come from projects, so this machinery does not apply. Read PRs once, from one environment (see c). Fan out *only* `linkedThreads` across every connected environment that supports thread PR links, and tag each thread with its environment. Today's `PullRequestRef` validates with any `projectId` once `host` and `owner/repo` are set (`ws.ts:515`). The clean fork option is a fork RPC/HTTP route keyed by `ThreadPullRequestKey`.

### (c) "All my open PRs across every repo"

- **Today's path is project-bound.** `PullRequestService` (`:1301-1440`) groups workspace projects by host and calls `api.listChangeRequestsAcross` (`PullRequestProvider.ts:377`). That calls `GitHubPullRequestProvider.ts:260` and then `GitHubPullRequestCli.searchPullRequests` (`:2022`).
  - `searchQuery()` (`:1015`) returns `null` for an empty repo list. That is deliberate, so there is no hidden "no `repo:`" mode to flip on.
  - Every resulting row goes through `toEntry({ project, ... })`.
- **`PullRequestListEntry` cannot carry the results.** Its `projectId: ProjectId` and `projectTitle: TrimmedNonEmptyString` are required (`packages/contracts/src/pullRequest.ts:498-508`). Making them optional would ripple into every list consumer: `observePullRequestSummary`, row keys, and detail references.
- **Smallest change.** Add a fork-only service `apps/server/src/fork/triage/TriageGitHub.ts` that depends on `GitHubCli` and `GitHubGraphQlBudget`. It copies the roughly 15-line `graphqlRead` pattern (`GitHubPullRequestCli.ts:1314-1376`): `budget.query`, then `gh api graphql --hostname <h> --input -`, then `budget.observe`, then decode.
  - It returns its own `TriagePullRequest` contract in `packages/contracts/src/forkTriage.ts`.
  - It touches zero upstream files.
  - The alternative is a `searchViewerPullRequests` method on `GitHubPullRequestCli`. That reuses `graphqlRead` and decoders but edits a 2.8k-line upstream file. Pick it only if upstreaming is planned.
- **Query string:** `is:pr is:open author:@me archived:false sort:updated-desc`, without any `repo:` qualifiers. The search returns at most 100 rows per page, so loop on `pageInfo.endCursor`.
- **Which environment reads it.** The environment the triage page is pointed at. By default that is the local or Mac fork server, whose `gh` login is Michael's. Hosts are github.com only (YAGNI on Enterprise).
- **Mapping a PR to a project.** Match `repository.nameWithOwner` against each environment's project `repositoryIdentity` on the client. Only the "open thread here" and "start thread" actions need it.

### (d) Bulk facts in one query: yes, except `mergeStateStatus`

Measured live on 2026-10-02 against Michael's 34 open PRs:

| Variant | Wall time | Cost | Nodes |
|---|---|---|---|
| Full: threads(50) + comments(last:1) + `mergeable` + `mergeStateStatus` | **502 timeout** at 25+ PRs; 5.0 s at 10 PRs | 1 | 620 |
| Same but without `mergeStateStatus` | **4.1–4.8 s** | **27** | 7,100 |
| `mergeStateStatus` alone, 34 PRs | 8.8 s | 1 | 50 |
| `mergeable` alone, 34 PRs | 1.2 s | 1 | 50 |

Recommended bulk query (one request; add `pageInfo`/`after` for more than 100 PRs):

```graphql
search(query: $q, type: ISSUE, first: 50) {
  pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest {
    number title url isDraft headRefOid updatedAt createdAt baseRefName headRefName
    repository { nameWithOwner }
    reviewDecision mergeable
    commits(last: 1) { nodes { commit { committedDate
      statusCheckRollup { state }
      checkSuites(first: 20) { nodes { status conclusion } } } } }
    latestOpinionatedReviews(first: 20) { nodes { state author { __typename login } } }
    reviewRequests(first: 20) { totalCount }
    reviewThreads(first: 50) { totalCount nodes { isResolved isOutdated path
      comments(last: 1) { nodes { author { __typename login } createdAt } } } }
  } }
}
```

Notes:

- **Cost and budget.** The cost is driven by `reviewThreads × comments`. `first: 20` threads drops it to about 12 points. `githubGraphQlBudget.ts` keeps a 10% reserve of the hourly limit (5,000 points here; 2,100 were left at measurement time because other tools were spending). A 5-minute refresh is about 324 points/h at 27 points, which is fine. Pass `allowReserve: false` so triage never eats the reserve.
- **Threads past the page.** If `reviewThreads.totalCount > 50`, re-read that PR with the existing paged `REVIEW_THREADS_GRAPHQL_QUERY`. The max seen today was 3.
- **Bot vs human.** `__typename` decides: CodeRabbit came back as `Bot:coderabbitai`, Michael as `User:Silthus`. Keep the `KNOWN_BOTS` fallback from audit-prs.
- **What stays out of the bulk query.** `mergeStateStatus` is computed lazily per PR at about 0.25 s each and causes the 502s. Derive it instead:
  - DIRTY = `mergeable: CONFLICTING`
  - UNSTABLE ≈ rollup `FAILURE`
  - BLOCKED ≈ `reviewDecision != APPROVED`
  - BEHIND and `behindBy` (needs `baseRef.compare(headRef:)` with a per-PR argument) come from the detail read only.
- **Awaiting CI authorization** needs `checkSuites.conclusion == ACTION_REQUIRED`, which is why `checkSuites(first:20)` is in the query.
- **502 retries.** GitHub returns 502 on heavy queries. `GitHubCli.execute` has no retry for `api graphql`, so the triage service needs a bounded retry (audit-prs: 4 attempts, linear backoff).

## 2. Seam list

| Seam (file:symbol) | Use |
|---|---|
| `apps/server/src/sourceControl/GitHubCli.ts:287 GitHubCli.execute` | Run `gh api graphql` with stdin, using the user's `gh` login. No token handling. |
| `apps/server/src/sourceControl/githubGraphQlBudget.ts GitHubGraphQlBudget.query/observe` | Rate-limit reservation and observation. Adds `rateLimit{...}` automatically. |
| `apps/server/src/pullRequest/GitHubPullRequestCli.ts:1314 graphqlRead` | Pattern to copy (budget → execute → observe → decode). |
| `apps/server/src/pullRequest/gitHubPullRequestJson.ts:807 pullRequestSearchGraphQlQuery` | Reference search document and decoders. Search page max is 100 (`:789`). |
| `apps/server/src/pullRequest/gitHubPullRequestJson.ts REVIEW_THREADS_GRAPHQL_QUERY` | Paged fallback for PRs with many threads. |
| `apps/server/src/pullRequest/GitHubPullRequestCli.ts:488 getViewerLogin` | Viewer login, cached 10 min. |
| `apps/server/src/textGeneration/TextGeneration.ts:81 TextGeneration` | Add `generateJudgement`. Each provider's `run*Json` does schema-enforced JSON. |
| `packages/shared/src/serverSettings.ts:84 resolveSourceControlWriterModelSelection` / `settings.textGenerationModelSelection` | Which model judges. |
| `apps/server/src/pullRequest/linkedThreads.ts:16 listLinkedPullRequestThreads` | PR → threads on one environment's database. |
| `packages/contracts/src/orchestration.ts:776 ThreadPullRequestKey` | Projectless `{host, repository, number}` key. |
| `packages/client-runtime/src/state/pullRequests.ts:206 pullRequestEnvironment.linkedThreads` | Per-environment linked-threads atom to fan out. |
| `apps/web/src/state/pullRequests.ts:203 createMergedEnvironmentQuery` | Fan-out/union over environments. Copy it into fork state (it is module-private). |
| `apps/web/src/components/pullRequest/PullRequestThreadLinks.tsx:36 threadPullRequestLinkMode` gate (from `@t3tools/client-runtime/thread-pull-request-compatibility`) | Skip environments without the thread-PR-link capability. |
| `apps/web/src/components/pullRequest/pullRequestProjectAssignment.logic.ts:86 resolvePickableEnvironments` | "Where can I act on this repo" picker for start-thread actions. |
| `packages/client-runtime/src/operations/commands.ts:270 linkThreadPullRequest`, `:128 createThread` | Link an existing thread; create a thread. |
| `apps/web/src/hooks/useHandleNewThread.ts:57 useNewThreadHandler` + `PullRequestDetailPanel.tsx:1118 openThreadWithTask` | Start a thread with a prefilled prompt (the user presses send). |
| `apps/server/src/mcp/toolkits/pullRequests/tools.ts:188 link_pull_request` | Agents already link PRs to threads. |
| `apps/web/src/components/sidebar/SidebarChrome.tsx:129 SidebarUtilityMenu` + `mainAppLocation.ts:7 isSidebarUtilityPage` | Sidebar entry and Back-button page list (two hook lines). |
| `apps/web/src/routes/_chat.<name>.tsx` | New route. `routeTree.gen.ts` regenerates. |
| `apps/server/src/server.ts makeRoutesLayer` | One `Layer.provide(forkTriageLayer)` hook line for a fork HTTP API. |
| `packages/client-runtime/src/state/environmentHttpAuth.ts:87 executeAuthenticatedEnvironmentHttpRequest` | Authenticated per-environment HTTP for local, relay, and DPoP. Use this instead of hand-rolled headers. |
| `apps/web/src/hooks/useLiveRefresh.ts shouldLiveRefresh` | Visible-window 5-minute refresh policy. |

## 3. Harvest list

### Prior fork branch `t3code/build-github-pr-monitor` (6.4k lines over 42 files vs `b5a0f8101`)

Verdict: it was over-built. It had a parallel GitHub client, its own inference stack, its own storage and leases, and a generic issue/relationship model. Very little of it touched T3's existing services.

| Item | Verdict | Why |
|---|---|---|
| `apps/desktop/src/fork/ForkDesktopIdentity.ts` + `DesktopAppIdentity`/`DesktopEnvironment` hooks | **Port** | Separate app name, bundle id, T3 home, and user-data directory. Never touches `~/.t3/userdata`. This is exactly the "launch on the MacBook" leg. |
| `scripts/fork/install.ts` + `README.md` (`install`/`launch`/`inspect`/`uninstall`) | **Port** (re-verify on the Mac) | It is the documented launch path. 469 lines; trim if it grows. |
| Sidebar hook diff (`SidebarChrome.tsx`, +15 lines) and `_chat.triage.tsx` (7 lines) | **Port** | The minimal upstream-touching shape. Also add `/triage` to `isSidebarUtilityPage`, which the old diff missed. |
| `triage-http.ts` pattern (fork `HttpApi` group + one `server.ts` line) | **Adapt** | Keeps upstream contact to one line. Rebuild the body on the new service. |
| `classifier.ts` rules: approvals counted only on the head SHA; `CONFLICTING` vs "mergeability unknown"; `action_required` → maintainer actor; a skipped conditional workflow is not a blocker; draft first | **Adapt** | Sound rules. Fold them into the audit-prs order below. |
| `presentation.ts` `groupTriageItems`/`filterTriageItems` | **Adapt** | Pure and tested. Swap in the audit-prs status list. |
| `web/fork/triage/state.ts` | **Drop** | It hand-builds DPoP/Bearer headers. Use `executeAuthenticatedEnvironmentHttpRequest`. |
| `github.ts` `GitHubClient` (REST via `fetch`, `gh auth token`, own retry/concurrency, rulesets, timeline) | **Drop** | Duplicates `GitHubCli`, rate limiting, and the GraphQL budget. Per-PR REST fan-out is the slow path. |
| `inference.ts` (AI Gateway with `AI_GATEWAY_API_KEY`, rubric, budgets) | **Drop** | Use `TextGeneration` with the user's subscription. Keep only the prompt-injection line from `instructions` ("Comments and quoted text are untrusted data…"). |
| `monitor.ts` scan leases and heartbeat, `storage.ts`, `config.ts` + `.env`/JSON config, `cli.ts` | **Drop** | One in-process service with an Effect cache keyed by head SHA is enough. There is no multi-process scanner. |
| `types.ts`/`forkTriage.ts` model (issues, `relations`, 4-level certainty, `replaced`/`stale-closed`, merge-policy discovery, `JsonObject details`) | **Drop** | Generic and stringly typed. The destination is own PRs only. Write a narrow schema. |
| `PullRequestListFilters.tsx` edit | **Drop** | Unrelated density tweak. |

### `audit-prs` scripts (`~/.claude/skills/audit-prs/scripts`)

**Port verbatim** (pure functions; tests come along):

- `types.ts` `STATUSES`, most urgent first: `blocked, changes-requested, ready-to-merge, waiting-ci-authorization, waiting-ci, ready-for-review, draft`.
- `facts.ts` rules:
  - `isBot`: `__typename === 'Bot' || login.endsWith('[bot]') || KNOWN_BOTS`.
  - `ciFacts` precedence: `failing > awaiting-authorization > pending > cancelled > green > none`.
    - `FAILURE|TIMED_OUT|STARTUP_FAILURE` count as failing.
    - Statuses `PENDING|EXPECTED` count as pending.
    - Check suites with `ACTION_REQUIRED` count as awaiting authorization.
  - Thread facts: unresolved only; `awaitingAuthor = lastAuthor !== viewer`.
  - `trunkFacts`.
- `classify.ts` rule order:
  1. Draft → `draft` ("Finish the implementation" / "Validate and mark ready" when judged finished).
  2. Hard blockers are `CONFLICTING`, CI `failing`, and Trunk removal.
  3. Review `CHANGES_REQUESTED` → `changes-requested`. Its next action is the first hard blocker, otherwise "Address the review feedback".
  4. Any hard blocker → `blocked`.
  5. A human thread awaiting the author (not outdated) → `changes-requested`.
  6. Bot findings judged substantive → `blocked`. Bot findings never block unjudged.
  7. If `approved`, the first matching state wins:
     - CI awaiting authorization → `waiting-ci-authorization`
     - CI cancelled → `waiting-ci` ("Re-run CI")
     - CI pending or none → `waiting-ci`
     - otherwise `ready-to-merge` ("Merge it", or "Comment /trunk merge" when Trunk manages the repo)
  8. Otherwise → `ready-for-review` ("Ask for review", plus a CI note).
- `signals()`:
  - Stale means no push for 14 days or more (`STALE_DAYS`); it suggests modernize.
  - Otherwise flag conflicts.
  - Count human and bot threads awaiting the author.
- `report.ts` `snapshot`/`diff`: "what changed since last look". `lowReady` treats a low-confidence `ready-to-merge` as always news.

**Adapt:**

- `risk.ts` `RUBRIC`, `excerptDiff` (40k diff budget, 8k per file, low-signal files only named), `parseJudgement`, and the cache key `headSha:RUBRIC_VERSION`. Drafts stay unscored. Run it through `TextGeneration.generateJudgement`; it replaces the agent-in-the-loop `score.ts`.
- The Jev questions (`humanChangesPending`, `botFindingsSubstantive`, `draftFinished`) become extra fields in the same judgement call. Until then they surface as `openQuestions`, as audit-prs does.

**Drop:**

- `jev.ts` and `key.ts` (Vercel AI Gateway key and calls).
- `store.ts` JSON files.
- `github.ts` token and `fetch`, with one exception: keep its rule that PRs into forks (`repository.isFork`) are skipped as private scratch work. Make that a filter.

**Reconcile with Postpile (#7).** Postpile's order is questions → merge queue → unresolved threads → change requests → awaiting reviewers → merge. Use the audit-prs order and surface `openQuestions` as Postpile's "questions" badge rather than as a status. Rank merge queue and Trunk under `blocked` or `ready-to-merge`. The alternative is to adopt Postpile's order literally.

---

## Appendix A: PR surfaces map (conductor input, `/tmp/wf-triage/t3-pr-surfaces.md`)

Here's the map. All paths are relative to `/home/coder/dev/t3code`. One thing matters for the plan: GitHub listing is always limited to the workspace projects' repositories, so "all my open PRs across every repo" doesn't exist yet (see §5).

### 1. Sidebar bottom-left and routing
- **Where the entries live:** `apps/web/src/components/sidebar/SidebarChrome.tsx`
  - `SidebarUtilityMenu` (:129) renders Settings, Pull Requests and Usage as `SidebarUtilityItem` (:104), an icon button with a tooltip, inside `SidebarChromeFooter` (:206).
  - The PR entry is gated on `environment.serverConfig?.environment.capabilities.pullRequests` (:139). It navigates to `/pull-requests` with `search: readPullRequestListPreferences()` (:147).
  - Usage navigates to `/usage` (:159).
- **Back-button pages:** `apps/web/src/components/sidebar/mainAppLocation.ts` `isSidebarUtilityPage()` (:7) lists the paths that swap the row for a Back button. A new path must be added there.
- **Other hardcoded `/pull-requests` references:**
  - `CommandPalette.tsx` :753, :767, :2227
  - `lib/openPullRequestLink.ts` :288, :305
  - `AppSidebarLayout.tsx` :82 (usage only)
- **Routes:** `apps/web/src/routes/`, TanStack flat-file naming.
  - `_chat.tsx` is the layout with the sidebar. `_chat.pull-requests.tsx` becomes `createFileRoute("/_chat/pull-requests")` (:295).
  - `usage.tsx` is top level (`/usage`), outside `_chat`.
  - A dashboard would be `_chat.pr-triage.tsx` (or similar) with `createFileRoute("/_chat/pr-triage")`.
- **`routeTree.gen.ts`** is generated by `tanstackRouter({ autoCodeSplitting: true })` in `apps/web/vite.config.ts:173` when dev/build runs. Don't hand-edit it.

### 2. Existing PR list
- **Route:** `apps/web/src/routes/_chat.pull-requests.tsx` (2,596 lines).
  - `PullRequestsRouteView` (:343). `validateSearch` (:296) covers `involvement`, `state`, `sort`, `q`, `draft`, `review`, `checks`, `author`, `labels`, plus `environmentId`, `projectId`, `host` and the selected-PR fields.
  - Tabs and sorts are at :228–249. `sort` is one of `ready | blocked | updated | newest | oldest | largest | smallest`.
  - `PAGE_SIZE = 99` (:260).
- **Components** in `apps/web/src/components/pullRequest/`: `PullRequestRow`, `PullRequestListRow`, `PullRequestListFilters`, `PullRequestListEmptyState`, `PullRequestGhosts`, `PullRequestsUnavailableState`, `PullRequestDetailPanel`.
- **Pure logic:** `pullRequestList.logic.ts`. It has `parsePullRequestQuery`, `groupPullRequestsByInvolvement`, `rankPullRequestsByMergeReadiness` (:1018), `rankPullRequestsBlockedOnAuthor`/`OnReviewer` (:1056/:1070), `sortPullRequestGroups`, `mergePullRequestLists`. Preferences are persisted by `pullRequestListPreferences.ts`.
- **Data path:**
  - Web hooks in `apps/web/src/state/pullRequests.ts`: `usePullRequestList` (:291), `usePullRequestListStats` (:317) and `usePullRequestTurnRefreshes` (:270). These fan out across environments through `createMergedEnvironmentQuery` (:203).
  - Those hooks sit on atoms from `createPullRequestEnvironmentAtoms` in `packages/client-runtime/src/state/pullRequests.ts:151`.
  - The atoms call WS RPCs. The method names are in `packages/contracts/src/rpc.ts:412-439`: `pullRequests.list`, `listStats`, `summary`, `detail`, `activity`, `linkedThreads`, `invalidate`, `subscribeRefreshes`, and others.
  - Server wiring: `apps/server/src/ws.ts:3026` (list) and :3062 (linkedThreads).
- **Fields available** (`packages/contracts/src/pullRequest.ts`):
  - `PullRequestListEntry` (:498):
    - Identity: `provider`, `host`, `projectId`, `projectTitle`, `repository`, `number`, `title`, `url`, `author`
    - Branches and state: `headBranch`, `baseBranch`, `state`, `isDraft`, `mergeability`
    - Size and timing: `additions`/`deletions` (filled later via listStats), `createdAt`, `updatedAt`, `observedAt`
    - Review and checks: `viewerReviewRequested`, `labels`, `reviewDecision` (GitHub only), `checksState` (`passing | failing | pending`), `stack`
  - **Review threads are not in list entries.** They are only in `PullRequestActivity.reviewThreads` (:892, `PullRequestReviewThread` :239 has `isResolved` and `isOutdated`).
  - `PullRequestDetail` (:825) adds `checks[]`, `reviewers`, `mergeCapabilities`, `baseComparison`/`behindBy`, `autoMergeEnabled` and `viewer`.
  - Filters are in `PullRequestListFilters` (:51). The list result's `viewers` field maps each host to the signed-in login (:632).
- **Server:** `apps/server/src/pullRequest/PullRequestService.ts`
  - Service interface at :171. It finds projects via `listWorkspaceProjects` (:707), which reads `ProjectionSnapshotQuery.getProjectShells`.
  - Provider registry: `PullRequestProviderRegistry.ts`. Providers exist for GitHub, GitLab, Bitbucket, Azure DevOps and Forgejo.
  - GitHub path: `GitHubPullRequestProvider.ts` (:218 `listPullRequests`, :262 `searchPullRequests`), then `GitHubPullRequestCli.ts`, which shells out to `gh`.
    - `searchPullRequests` (:2022) is a GraphQL search through `gh api graphql --input -`.
    - The query string comes from `searchQuery()` (:1015): `is:pr is:open author:<viewer>|review-requested:<viewer> … sort:updated-desc repo:a repo:b…`, up to 100 repos per search (`REPOSITORY_SEARCH_CHUNK`, service :119).
- **Caching and refresh:**
  - Server TTLs (:130–148): list 30s, detail 15s, diff 60s, stats 60s, viewer 10m. A persisted read cache lives in `PullRequestReadCache.ts` (filesystem KeyValueStore).
  - `invalidate` wipes the cache and is used by the refresh button (route :854/:894).
  - `refreshAfterTurn` (:3126, called from `CheckpointReactor.ts:976`) bumps the `subscribeRefreshes` stream, so open lists re-read after an agent turn.
  - Client polling: `apps/web/src/hooks/useLiveRefresh.ts`. Every 5 minutes while the window is visible, at least 10s apart, stopping after 6 minutes idle. Used at route :1230.

### 3. PR ↔ thread linking
- **MCP tools:** `apps/server/src/mcp/toolkits/pullRequests/tools.ts` defines `link_pull_request` (:188), `unlink_pull_request` and `list_thread_pull_requests`.
  - Handlers in `handlers.ts:192` dispatch `thread.pull-request.link` with `source: "agent"` through `OrchestrationEngineService.dispatch`.
  - A duplicate link raises `OrchestrationCommandInvariantError`, which the handler maps to `alreadyLinked=true`.
- **Contracts** (`packages/contracts/src/orchestration.ts`):
  - `ThreadPullRequestLinkSource` (:722): `manual | created | agent | stack | stack-dismissed`.
  - `ThreadPullRequestSnapshot` (:736), `ThreadPullRequestKey` (:776, keyed by host/repository/number), `ThreadPullRequestLink` (:783).
  - `OrchestrationThread.pullRequests[]` (:806), plus legacy `linkedPullRequest` and `branchPullRequest`.
  - Commands at :1260/:1269. Events `thread.pull-request-linked/unlinked/synced` at :2127.
- **Storage:**
  - Decider: `decider.ts:1059`.
  - Projection: `projector.ts:666`, `ProjectionPipeline.ts:877`.
  - Table `projection_thread_pull_requests`, created in `persistence/Migrations/050_ProjectionThreadPullRequests.ts:35`, with an index by PR.
  - Repository: `persistence/ProjectionThreadPullRequests.ts` (`listByPullRequest`, `listByThreadId`).
- **Reverse lookup (PR → threads):** `pullRequest/linkedThreads.ts:16` `listLinkedPullRequestThreads` runs SQL that joins `projection_threads`.
- **Background sync:**
  - `orchestration/PullRequestSyncReactor.ts` refreshes link snapshots every minute (:344) and auto-links native stacks.
  - `ThreadPullRequestReactor.ts` discovers `branchPullRequest` from the thread's branch (:201, every minute at :418).
  - `git/linkCreatedPullRequest.ts` links PRs that a git action created (`source: "created"`).
- **UI:**
  - `components/pullRequest/PullRequestThreadLinks.tsx` shows a count, a link/unlink menu item, and a `ThreadPicker`. It uses the `pullRequestEnvironment.linkedThreads` atom.
  - Clicking the count opens the command palette with `linkedThreads` (:120), and navigation to the thread happens from there.
  - Linking from the UI: `hooks/usePullRequestLinking.ts`. Client command helpers are `linkThreadPullRequest` and `createThread` in `packages/client-runtime/src/operations/commands.ts:270` and :128.
- **Creating a thread from the UI:**
  - `useNewThreadHandler()` in `apps/web/src/hooks/useHandleNewThread.ts:57` opens a draft (`{draftId, threadId}`) with optional `branch`, `worktreePath` and `envMode`.
  - `PullRequestDetailPanel.tsx:1118` `openThreadWithTask` writes the prompt and review comments into the composer. The user still has to press send.
  - `startHandoff` (:1181) runs `git.preparePullRequestThread` to make a worktree, then re-points the draft.
  - The actual server-side creation happens on send: `thread.turn.start` with `bootstrap.createThread {projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath}` (orchestration.ts :1292–1339; built in `ChatView.tsx:8007`).
  - Model and provider are chosen with `ModelSelection {instanceId, model, options?}` (:75).
- **Creating a thread with a PR already linked:** no single command does this. The options are:
  - `thread.create` followed by `thread.pull-request.link`.
  - Pointing the thread at the PR's head branch, so `ThreadPullRequestReactor` attaches it as `branchPullRequest`.
  - Composer context can carry `PullRequestContextMetadata` on review-comment records (`composerContext.ts:78`), but that is message context, not a link.

### 4. PR review features
- **Detail panel:** `PullRequestDetailPanel.tsx` has tabs `summary | timeline | code` (:186, :252). The tab files are `PullRequestSummaryTab.tsx`, `PullRequestTimelineTab.tsx` and the lazy-loaded `PullRequestCodeTab.tsx`.
- **Diff:**
  - Served over HTTP, not WS: `POST /api/pull-requests/diff` (`contracts/src/environmentHttp.ts:543`, server `pullRequest/http.ts`).
  - Client: `packages/client-runtime/src/state/pullRequestDiffHttp.ts`. Logic: `pullRequestDiff.logic.ts`.
- **Review threads:** placed inline in the Code tab (`PullRequestCodeTab.tsx:459`, using `ReviewThreadCard` from `PullRequestReviewAnnotation.tsx`). Threads that can't be placed are shown separately (:1379).
- **Writing reviews:** `PullRequestReviewForm.tsx`, `PullRequestCommentForm.tsx`, `pullRequestReviewStore.ts`.
- **Viewed files:** `usePullRequestFilesViewed.ts` on the web side; server `pullRequestViewedFiles.ts` and `persistence/PullRequestFilesViewed.ts` (migration 053).
- **File revisions:** `docs/internals/pull-request-file-revisions.md` explains `ProviderFileRevisions` in `PullRequestProvider.ts`: how a missing path changes meaning at the provider boundary, for hosts without native viewed-file state.

### 5. GitHub access on the server
- **Auth:**
  - All calls go through the `gh` CLI (`sourceControl/GitHubCli.ts`), using the user's `gh auth`.
  - `captureVerifiedCredential` (`GitHubPullRequestCli.ts:1109`) runs `gh auth token --hostname`, then `gh api user` with that token pinned in `GH_TOKEN`. Identity is cached for 10 minutes per credential fingerprint.
  - `PinnedGitHubCredential` (`GitHubCli.ts:38`) can override this.
- **Rate limits:**
  - `sourceControl/SourceControlRateLimit.ts` pauses a host with a 30s to 15m backoff (`SourceControlRateLimitPausedError`). It is applied in `withRateLimitBackoff` (`PullRequestService.ts:478`).
  - `sourceControl/githubGraphQlBudget.ts` tracks GraphQL `rateLimit` and keeps a 10% reserve.
- **Multi-host and multi-repo:** results are keyed by host (github.com and Enterprise are separate accounts). Up to 12 repositories are read concurrently, and same-host repos are batched into one search.
- **Scope:** only repositories of workspace projects (`repo:` qualifiers). `searchQuery` returns null for an empty repo list. Listing every open PR the viewer authored across all repos (e.g. `is:pr author:@me` with no repo filter) would need a new method in `GitHubPullRequestCli` and `PullRequestService`.
- **Multiple servers:** the web side merges results from several environments/servers (`assignProjectsToEnvironments`, route :637).

### 6. Scheduling and starting turns headlessly
- **No generic scheduled-task or cron infrastructure exists.** The precedent is long-running reactors that loop with `Effect.repeat(Schedule.spaced("1 minute"))` (`PullRequestSyncReactor.ts:344`, `ThreadPullRequestReactor.ts:418`).
  - They are started in `orchestration/Layers/OrchestrationReactor.ts` `start()` and forked via `forkParked` (`serverActivation.ts:12`).
  - Layers are provided in `apps/server/src/server.ts:273`.
- **Starting a turn from the server:**
  - Use `OrchestrationEngineService.dispatch` (`orchestration/Services/OrchestrationEngine.ts:114`): first `thread.create` (example: `serverRuntimeStartup.ts:249`), then `thread.turn.start` with `message {messageId, role:"user", text, attachments: []}`, `modelSelection`, `runtimeMode`, `interactionMode`, `createdAt` (example: `ProviderCommandReactor.ts:351`).
  - `ProviderCommandReactor` then starts the provider session.
  - Caveat: `bootstrap` handling (worktree preparation, setup script) only runs in `ws.ts` `dispatchBootstrapTurnStart` (:1082), not in the engine. A server-side job that wants a worktree has to reuse or extract that logic.

### 7. Tests
- **Commands:** `vp test run <files>` (AGENTS.md:107). No repo-wide checks. Wait on receipts and drains, never sleeps.
  - Server: `apps/server/package.json` runs `vp test run`.
  - Web: `vp test run --project unit`.
- **Location:** tests sit next to the source as `*.test.ts(x)`.
- **Server service test example:** `apps/server/src/pullRequest/PullRequestReadCache.test.ts` uses `@effect/vitest`'s `it.layer(NodeServices.layer)`, `it.effect`, and `TestClock.adjust`.
  - Bigger harnesses: `PullRequestService.test.ts` `makeService()` (:400) with fake providers and `SourceControlRateLimit.layer`; `orchestration/PullRequestSyncReactor.test.ts` `makeHarness` (:170).
- **Web pure-logic test example:** `apps/web/src/components/pullRequest/pullRequestList.logic.test.ts` imports `describe/expect/it` from `"vite-plus/test"` and exercises `rankPullRequestsByMergeReadiness`, `parsePullRequestQuery` and similar functions on plain `PullRequestListEntry` fixtures. `hooks/useLiveRefresh` exports pure `shouldLiveRefresh` for the same style of testing.

## Appendix B: Salvaged findings for (a) and (b) (`/tmp/wf-triage/t8-partial-a-b.md`)

Line references in this appendix point into a deleted worktree (`.claude/worktrees/agent-abf83361850193ac0`). The same relative paths exist at `6c8fed35d`, and the symbols cited in §2 were spot-checked there.

I got through (a) and most of (b). The worktree was deleted partway through the run, and every later command was refused with "the isolation worktree appears to have been removed". I stopped there instead of reading the main checkout, which might not match this branch. So (c) and (d) are not answered, and (b) has two gaps, flagged below. Line numbers are from the worktree as it was before it was removed.

### a) Text-generation service

**Interface.** There is no generic "prompt in, text out" method. The service `TextGeneration` (tag `"t3/textGeneration/TextGeneration"`) has exactly four methods, each tied to one purpose: `generateCommitMessage`, `generatePrContent`, `generateBranchName` and `generateThreadTitle`. Each one takes its own typed input, which includes `modelSelection: ModelSelection`, and returns `Effect<..., TextGenerationError>`. The top-level service only looks up the provider instance by `modelSelection.instanceId` and hands the call to `instance.textGeneration`.

**Structured output already exists on every path.** Each provider has a private `run*Json` helper that takes `{ operation, cwd, prompt, outputSchemaJson: S, modelSelection }` and returns `S["Type"]`. That is the generic primitive you want, but it isn't exported. The `operation` field is also typed to the four literal names.

| Provider | How it generates text | Schema enforcement |
|---|---|---|
| Codex | New `codex exec` process per call (`--ephemeral -s read-only --output-schema <tmp> --output-last-message <tmp>`, prompt on stdin) | Native |
| Claude | New `claude -p --output-format json --json-schema <json>` process per call (`--tools ""`, `--permission-mode dontAsk`, hooks disabled) | Native, read from `structured_output` |
| Cursor, Grok, Antigravity | Fresh ACP runtime per call, prompt, collect `agent_message_chunk` text | None: JSON is pulled out of the text and validated |
| OpenCode | Reuses the shared OpenCode server, creates a new session with all permissions denied, calls `session.prompt` | None: same text extraction |

**Latency and cost.** Every call starts a new subprocess or session. Timeouts are 180s for Codex, Claude, Cursor, Grok and Antigravity. I didn't see an explicit timeout in the OpenCode runner. There is no concurrency limit or semaphore anywhere in `textGeneration/`, so 30 PRs means 30 CLI processes unless the caller limits concurrency itself.

**Where the model comes from.** `serverSettings.ts` falls back to the first enabled provider when the selected one is disabled. Call sites read `settings.textGenerationModelSelection` or `resolveSourceControlWriterModelSelection`.

**Can a new triage service use it?** Yes, with no extra API key, because it goes through the user's existing CLI login or subscription. There are two ways in:
- **Recommended:** add a fifth method such as `generateJudgement({ cwd, prompt, outputSchema, modelSelection })`. Each `make*TextGeneration` would forward it to its existing `run*Json`, and `"generateJudgement"` would be added to the operation literal unions.
- **Hacky:** reuse `generatePrContent` with a fake diff. Don't.

Pass a neutral temp `cwd` the way Claude's title path already does, so the repo's own config isn't loaded.

Seams:
- `/home/coder/dev/t3code/.claude/worktrees/agent-abf83361850193ac0/apps/server/src/textGeneration/TextGeneration.ts:81 TextGeneration` — service tag with 4 methods; inputs at :13-76
- `.../textGeneration/TextGeneration.ts:118 resolveInstance` — looks up the provider instance by `modelSelection.instanceId`
- `.../textGeneration/TextGeneration.ts:137 make`, `:172 layer` — the layer is provided at `apps/server/src/server.ts:365`
- `.../provider/ProviderDriver.ts:89 ProviderInstance.textGeneration` — per-instance implementation slot
- `.../textGeneration/CodexTextGeneration.ts:41 CODEX_TIMEOUT_MS`, `:159 runCodexJson` (spawn args :210-232, `--output-schema` :224), method bodies :331-441
- `.../provider/Drivers/CodexManagedProvider.ts:221-247` — managed Codex wraps native generation in `auth.controller.withAccess`
- `.../textGeneration/ClaudeTextGeneration.ts:53 CLAUDE_TIMEOUT_MS`, `:124 runClaudeJson` (`--json-schema` :205, temp cwd for titles :189-198, decodes `structured_output` :294-299)
- `.../textGeneration/CursorTextGeneration.ts:30 CURSOR_TIMEOUT_MS`, `:46 runCursorJson` (ACP, `setMode("ask")`, `extractJsonObject` :143)
- `.../textGeneration/OpenCodeTextGeneration.ts:180 runOpenCodeJson` (session :214-246, `serverOwner.withServer` ~:336, `extractJsonObject` ~:349)
- `.../textGeneration/GrokTextGeneration.ts:35,46 runGrokJson`; `AntigravityTextGeneration.ts:36,122 runAntigravityJson` — both ACP
- `.../textGeneration/TextGenerationUtils.ts toJsonSchemaObject / extractJsonObject` — schema-to-JSON-Schema conversion and JSON extraction (I didn't open this file)
- Call sites:
  - `.../git/GitManager.ts:1871 generateCommitMessage`
  - `.../git/GitManager.ts:2060 generatePrContent`
  - `.../git/GitManager.ts:2706-2716` — picks `textGenerationModelSelection` or the source-control writer selection
  - `.../orchestration/Layers/ProviderCommandReactor.ts:938 generateBranchName` (selection at :929-935)
  - `.../orchestration/Layers/ProviderCommandReactor.ts:987`, `:1084 generateThreadTitle` (selection at :982, :1080)
- Settings:
  - `.../apps/server/src/serverSettings.ts:335 resolveTextGenerationProvider`, `:341 fallbackTextGenerationProvider`
  - `packages/shared/src/serverSettings.ts:84 resolveSourceControlWriterModelSelection`
  - `packages/contracts/src/settings.ts:1250` — schema field

### b) Cross-environment PR→thread links

**Input key.** The RPC payload is `PullRequestRef`: `{ projectId: ProjectId (required), host?, expectedAccountId?, allowStale?, repository, number }`. On the server, `resolvePullRequestSyncKey` turns it into a `{host, repository, number}` key.
- If `host` is set and `repository` contains a `/`, `projectId` is never read.
- Otherwise the server looks the project up in its own database to get `repositoryIdentity`. If that lookup fails, the result is `{threads: []}`.

**Scope.** The query reads only the receiving environment's own SQLite database (`projection_thread_pull_requests` joined to `projection_threads`). Nothing crosses environments.

**Which environment the web asks.** The client atom `linkedThreads` has no `execute: routedRequest`, unlike `labelCandidates` and `reviewerCandidates`. So it goes straight to the one `environmentId` it is given. It refreshes every 10s with staleTime 0. `PullRequestThreadLinks` passes `props.environmentId` and merges in the normalized `{host, repository, number}` parsed from the URL. Its own comment says "Thread relations belong to the detail environment, including when another environment is active."

**Gap 1.** I didn't confirm which environment `PullRequestDetailPanel` (:1657, :1851, :2023) passes as `environmentId`.

**Gap 2.** I didn't get to read `createMergedEnvironmentQuery` or `assignProjectsToEnvironments`. Those are the functions your question named, so the merge side is unchecked.

**Querying every connected environment.** It works today in practice:
1. Because the parsed URL always supplies `host` and `owner/repo`, `projectId` is ignored. You can pass any `ProjectId` string to make the schema validate (it's a `makeEntityId` brand).
2. Fan out `pullRequestEnvironment.linkedThreads({environmentId, input})` across all connected environments.
3. Skip environments where `threadPullRequestLinkMode(...)` is `"unsupported"` (the check in `PullRequestThreadLinks`).
4. Union the `threads` results and tag each one with its `environmentId`.

The clean version is a new payload of `ThreadPullRequestKey` (`{host, repository, number}`, no `projectId`), or making `projectId` optional when `host` is present. Also note the 10s polling would multiply by the number of environments.

Seams:
- `packages/contracts/src/pullRequest.ts:660 PullRequestRef` — `projectId` required
- `packages/contracts/src/pullRequest.ts:696 PullRequestLinkedThreadsResult` — `{threads:[{id, projectId, title, archivedAt}]}`
- `packages/contracts/src/orchestration.ts:776 ThreadPullRequestKey` — `{host, repository, number}`, the natural projectless key
- `packages/contracts/src/rpc.ts:784 WsPullRequestsLinkedThreadsRpc` — `payload: PullRequestRef`
- `apps/server/src/ws.ts:515 resolvePullRequestSyncKey` — skips the project when host and owner/repo are present
- `apps/server/src/ws.ts:3062` — handler
- `apps/server/src/pullRequest/linkedThreads.ts:16 listLinkedPullRequestThreads` — local SQL, excludes `stack-dismissed` and deleted threads
- `packages/client-runtime/src/state/pullRequests.ts:206 linkedThreads` — direct per-environment atom, no routing
- `apps/web/src/components/pullRequest/PullRequestThreadLinks.tsx:35-38` — capability gate
- `apps/web/src/components/pullRequest/PullRequestThreadLinks.tsx:57-67` — single-environment query

### c) "All open PRs authored by viewer across all repos"

**Not answered.** The worktree disappeared before I opened `GitHubPullRequestCli.ts`, `GitHubPullRequestProvider.ts`, `PullRequestService.ts`, or the `PullRequestListEntry` schema around `pullRequest.ts:498`.

### d) Bulk review-thread data

**Not answered**, for the same reason. I didn't open `githubGraphQlBudget.ts` or the review-thread GraphQL query.

To finish (c), (d) and the two gaps in (b), I need to rerun in a live worktree or point at the main checkout, if it matches this branch.
