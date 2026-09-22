# Fork triage monitor

The monitor reads GitHub issues and pull requests. It does not change GitHub data or start coding agents. It stores reports, evidence, inference costs, and change history in a separate SQLite database.

## Dashboard

Open T3 Code Fork, then select GitHub triage in the sidebar footer. Refresh starts a GitHub scan. The server also scans every 15 minutes while the fork app runs. Ordinary T3 development starts use manual refresh unless `T3CODE_TRIAGE_AUTOSTART=true` is set. The dashboard reads the stored report every minute.

The view groups PRs by the action they need. It uses the existing pull request rows and detail view. Select Thread to open a matching PR's thread in the same environment. GitHub and evidence links open GitHub. Copy Markdown copies the current filtered report. A copied T3 database is an initial snapshot; the fork and original app do not synchronize new threads.

See [the fork launcher guide](../../scripts/fork/README.md) for installation, launch, and upstream sync. The native mobile client has no dashboard route in this version. The web and desktop clients use the same authenticated environment API, including remote connections.

## Setup

Authenticate with `gh auth login`. Copy `apps/server/src/fork/triage/fixtures/config/triage.example.json` to a private configuration file. Set `T3CODE_TRIAGE_CONFIG` to its absolute path for the dashboard and CLI. The fork stores its monitor database under `t3-home/userdata/fork-triage`. Set `--data-dir` to that directory to inspect the dashboard through the CLI. The default CLI data directory is `~/.t3-fork-triage`. Set `T3_FORK_TRIAGE_DATA_DIR` to use another directory outside the repository and outside the normal T3 database.

The default scopes include open pull requests by `Silthus` in `PostHog/posthog` and `PostHog/posthog.com`, plus all issues and pull requests in `Silthus/posthog`. `username` changes the upstream author. `lookbackDays` defaults to 30 for closed items. Previously tracked open items are refreshed directly if they disappear from a listing.

For discussion judgments, create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys) and set `AI_GATEWAY_API_KEY` in the environment that starts the CLI. For the installed fork app, add `AI_GATEWAY_API_KEY=your-key` to `~/Library/Application Support/T3 Code Fork/secrets.env`, then restart the app. A missing key leaves discussion judgments unevaluated. GitHub facts still refresh.

```sh
bun apps/server/src/fork/triage/cli.ts --help
bun apps/server/src/fork/triage/cli.ts doctor
bun apps/server/src/fork/triage/cli.ts scan --format json
bun apps/server/src/fork/triage/cli.ts status --format markdown
bun apps/server/src/fork/triage/cli.ts changes
bun apps/server/src/fork/triage/cli.ts explain PostHog/posthog#104165
bun apps/server/src/fork/triage/cli.ts watch
```

`watch` scans immediately, then repeats at `refreshIntervalMinutes`. Only one watch process can own a data directory. Stop it with Ctrl+C. The monitor pauses when the computer sleeps. Offline refreshes preserve prior evidence. Automatic launchd installation is not included.

## Read the report

Lifecycle, blockers, actors, and freshness are separate. A draft can have conflicts, failed checks, review requests, and manual validation requests. A merged pull request is shipped. A closed pull request is not automatically stale. A replacement is shipped only if an explicit replacement assertion points to a verified merged target.

The monitor reads branch rules, current revision checks, commit statuses, Actions runs, review decisions, unresolved review threads, and native issue relations. Green scanners and conflict-free branches do not prove readiness. `PostHog/posthog` defaults to maintainer enqueue in its external queue. A configured merge policy overrides discovered check and approval requirements. Set `externalQueue: "maintainer"` when such a policy needs external enqueue. Required skipped checks block by default; set `skippedChecks: "accept"` only if the repository policy accepts them.

A parent reports the number of fetched children and closed children. An open native dependency remains a blocker. Text links remain uncertain candidates unless the report has an explicit verified replacement assertion. Discussion about a running worker is not execution telemetry.

`status` recalculates freshness and inactivity without calling Jev. `stalledAfterDays` defaults to 14. An inactive open item keeps its lifecycle. A partial refresh retains prior evidence and the original successful refresh time.

## Costs and judgments

The monitor uses [Vercel's evaluation endpoint](https://vercel.com/docs/ai-gateway/modalities/evaluation) with `typesafe-ai/jev`. Independent questions assess manual validation, author action, discussion blockers, next role, and supplied link meaning. The model returns structured choices. Labels come from the monitor. Discussion is untrusted input and cannot authorize actions or change the rubric.

The default confidence threshold of 0.85 is provisional. The fixture examples test behavior; they do not calibrate confidence on live workflows. Missing confidence and ambiguous answers remain uncertain. No live Jev call was verified during implementation because the key was absent.

The [Jev gateway promotion](https://vercel.com/ai-gateway/models/jev) ends on September 25, 2026. The monitor does not assume permanent free use. Its configurable estimate is $0.042 per million input tokens with free output, based on [TypeSafe pricing](https://docs.typesafe.ai/models). It uses UTF-8 byte count as a conservative input token estimate. Provider-reported tokens and cost remain separate from estimates. Unknown failed attempts retain their cost reservation.

`inference.requestBudget` limits each scan. `dailyRequestBudget`, `monthlyRequestBudget`, `dailyCostBudgetUsd`, and `monthlyCostBudgetUsd` persist across restarts. Zero disables new requests for that budget. Every retry counts. Cached results remain available after request budgets are exhausted. Oversized input is rejected visibly and is not silently cut.

The cache includes normalized discussion, questions, rubric version, provider, model, and `configuredModelVersion`. New checks do not invalidate discussion judgments. `configuredModelVersion` invalidates the local cache; it cannot pin the gateway model slug to immutable weights. The report keeps the returned model identifier.

## Explicit limits

GitHub search exposes at most 1,000 results per query. Other collections stop at `githubPageLimit`. Linked target traversal stops at 20 direct targets. Review requests and closing issue links are limited to 100; additional results are marked incomplete. Review threads paginate. Missing permissions and incomplete collections remain visible.

Required organization workflows are not matched to cross-repository workflow identities. The report retains an unknown blocker for them. Current external queue membership is not verified. A maintainer must confirm it. Textual dependency semantics are advisory and cannot override GitHub facts. The monitor never starts a claimed worker or checks that worker's process.

## Troubleshooting

The installed app runs this checkout. Keep the checkout and its dependencies in place. After a configuration or secrets change, restart the fork app. Check the launcher log path in the fork launcher guide if the window does not open. Use `doctor` to check GitHub authentication and key presence without printing credentials.

A full scan of the initial scopes used about 1,100 GitHub API requests. The server waits 15 minutes after each scan finishes. Reduce scopes or increase `refreshIntervalMinutes` if other tools share the same GitHub rate limit. Reports retain evidence and history on disk; monitor the size of `triage.sqlite` for long-running use.
