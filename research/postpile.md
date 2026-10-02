# Postpile: what it does and what T3 triage should borrow

Research for [Silthus/t3code#7](https://github.com/Silthus/t3code/issues/7), part of the map [#6](https://github.com/Silthus/t3code/issues/6).

Source: `PostHog/postpile` at commit [`67a2b82`](https://github.com/PostHog/postpile/tree/67a2b82aab6a39d820cf49b68f2999080f74d2cc) (2026-10-02). MIT licensed, so we can port code if we keep the copyright notice. Paths below are relative to that commit. `P/` stands for `https://github.com/PostHog/postpile/blob/67a2b82aab6a39d820cf49b68f2999080f74d2cc/`.

## TL;DR

Postpile is a **reviewer's inbox**, not an author's dashboard. It starts from the GitHub notifications inbox, groups PRs into agent-made *topics*, and answers "whose move is it?" on each tile. Its rules for the *reviewer* side are deep and well tested. Its rules for **your own PRs** are thin, and three deliberate decisions hide exactly what Michael wants to see:

1. **Bot review findings are ignored on your own PR.** Unresolved threads whose last comment is a bot's never count as your move (`threadsWaitingOnViewer` skips `isBot(last.author)`, `P/packages/core/src/whose-turn.ts`). Bot-only activity is auto-marked read on GitHub ("Handled quietly", `P/DESIGN.md` L4434). The owner's words: "I never care about bot replies" (`P/NEXT.md` L1222). So adversarial and AI review output disappears.
2. **CI is not a signal anywhere** (`P/DESIGN.md` "CI is not a signal", L434). It is not a move, not in risk, and not in any agent prompt. That works for a reviewer. For an author, it removes "fix CI" as a next action.
3. **No mergeability and no refinement ladder.** The PR query has no `mergeable` or `mergeStateStatus` (`P/packages/github/src/queries.ts`), so conflicts are invisible. Own-PR state is lifecycle + `reviewDecision` only. An open, non-draft own PR with no reviewers requested and no approval gets turn `none`, so the UI says nothing. That is the gap Michael hit: "doesn't help me clearly answer what state my PRs are in".

Borrow the rule engine shape, the own-PR turn rules, the thread and change-request rules, the bot list (to *classify* bots, not to drop them), approval provenance, the risk format, the glance cache and stale states, and the GitHub quota and polling discipline. Skip topics, dossiers, notifications-as-source, Mac pings, and GitHub write-back.

## What Postpile is

- macOS Electron app. Three panes: topics sidebar | one column of tiles | detail pane (`P/README.md`, `P/AGENTS.md`, `P/DESIGN.md` "Three-pane balance" L2938).
- **Topics**: agent-maintained clusters of PRs with one goal ("Move CI to Depot"), each with a dossier, facts and a status (`P/DESIGN.md` "Product model" L5). **Tiles** sit inside a topic: one PR, a git stack (from base/head refs), or an agent-grouped "set".
- Each tile answers four questions in fixed spots: **for whom** (chip + left band), **why now** (actor avatar + headline event), **status** (lifecycle icon + review word + verdict pill), **whose turn** (footer sentence) (`P/AGENTS.md` "What the app is for"; `P/DESIGN.md` "Tile faces" L2287).
- "Rules first, agent second": deterministic rules decide loudness, tiers, whose turn and done-ness. Claude (via the `claude` CLI) clusters topics, writes glances (verdict, risk, does, othersSaid, keyFiles), and can lower or raise an event's loudness with a stored reason (`P/AGENTS.md` "Principles").
- Ships an MCP server so coding agents can ask `pr_context`, `whats_on_me`, `topic`, `search_prs` (`P/README.md` "Ask PostPile from other agents").

## Data sources

| Source | What | Where |
|---|---|---|
| REST `GET /notifications` | The primary feed. Polled every 60s with ETag/Last-Modified (304s are free). Obeys `X-Poll-Interval`. One extra poll on window focus, debounced 15s. | `P/packages/github/src/notifications.ts`, `P/DESIGN.md` "Live poll" L4688 |
| REST `GET /notifications?all=true&since=` | The read list, so reads done on github.com reconcile | `P/DESIGN.md` L302 |
| GraphQL "found" query | One request per full sync: `viewer.pullRequests(states: OPEN, first: 100)` plus searches `assignee:@me`, `user-review-requested:@me`, `team-review-requested:<team>` per team, `involves:@me is:merged merged:>=7d` | `P/packages/github/src/found.ts` `buildFoundQuery` |
| GraphQL PR batch | 12 aliased `repository { pullRequest }` per query, `prData` fragment: reviews(last 50), comments(last 60), reviewThreads(last 50, `isResolved`, first 30 comments), commits(last 50), head `statusCheckRollup`, timeline (review requests, ready/draft, force push, merge queue, deploy), files(100), labels, assignees. Capped lists are flagged and paged later ("cap-fill"). | `P/packages/github/src/queries.ts` |
| GraphQL freshness | `updatedAt` only, 100 aliases per query, to skip unchanged PRs | `queries.ts` `buildUpdatedAtQuery` |
| GraphQL branch lookup | PRs by head/base branch, to complete stacks | `queries.ts` `buildBranchQuery` |
| Auth | `gh auth token` | `P/packages/github/src/token.ts` |

Not fetched: `mergeable`, `mergeStateStatus`, thread `isOutdated`, check-run details beyond name/conclusion.

**Cadence.** Full sync on start, on "Sync now", and every 60 min. If a sync hits its 60-PR cap, the next one runs 2 min later to drain the backlog. After each full sync the poll runs once at once (`P/DESIGN.md` "Auto sync" L5183, "Big inboxes" L290).

**Rate limits** (`P/DESIGN.md` "GitHub quota" L5200, `P/packages/core/src/github-quota.ts`, `P/packages/github/src/http.ts` `rateLimitOf`). It reads `X-RateLimit-*` on every answer and tracks a level: `ok` (>50% left), `low` (≤50%: auto sync waits for the reset, poll slows to 1/min), `critical` (≤20%: the poll pauses too). Syncs the user asks for always run. Backoff waits for `Retry-After` or the reset, else doubles from 60s up to 15 min. At most 6 parallel GraphQL batches, because the secondary limiter cares about bursts (`P/packages/github/src/client.ts` `MAX_PARALLEL_BATCHES`).

## State model

- **Event loudness**: `loud | quiet | muted | seen`. Rules first (`LOUDNESS_TABLE` in `P/packages/core/src/loudness.ts`), then an optional agent override with a reason. Bots, CI, deploys and merge-queue chatter are quiet.
- **Tile state** is derived and never stored: `unread | snoozed | done | open` (`P/DESIGN.md` L218). "Done" means nothing is asked of you.
- **PR tier**, first match wins: `needs_reply → changes_requested → mine → team → to_review → team_mentioned → rest` (`P/packages/core/src/pr-tier.ts`, ported from the earlier tool "ghatchup").
- **Whose turn**: `{ kind: 'you'|'them'|'none', who, what, prKey, move? }`, where `move ∈ reply | re_review | review | address_changes | merge` (`P/packages/core/src/whose-turn.ts`). The tile takes its most urgent member: you, then them, then none.
- **Sidebar sections** hold topics, not PRs: Needs reply, Changes you requested, To review, Team mentioned, then You drive, Your team owns, Other work, Archive (`P/DESIGN.md` "Queue sections" L3054).
- **Glance** per PR: verdict `LOOKS_SAFE | LOOK_CLOSER | NOT_YOURS`, plus forYou, does, `risk` ("low|medium|high - what could break", ≤15 words), othersSaid and keyFiles. It is cached by a hash of its inputs and rewritten only when the PR moves (`P/packages/agent/src/prompts/glance-batch.ts`). Glance state: `ready | queued | writing | failed | agent_off | capped | none` (`P/packages/core/src/glance-state.ts`).

### Own-PR rules (the part that matters for Michael)

From `whose-turn.ts` `prTurn` → `queueTurn` → `ownPrTurn`, first match wins:

1. Merged or closed → none.
2. Draft → your move only for an unanswered personal ask, unresolved threads whose last word is someone else's ("Address 2 comments on your draft"), or a standing change request. Otherwise none.
3. A human asked you something you have not answered since your last touch. A touch is a comment, a review, or a push to your own PR → `reply`.
4. Merge queue: queued → "Waiting on the merge queue". Trunk failure → "Re-submit to the merge queue: <reason>".
5. Unresolved threads whose last comment is not yours **and not a bot's** → "Answer 3 threads from mira".
6. Standing change requests (`standingChanges`, `P/packages/core/src/changes-answered.ts`). If any reviewer has not been re-requested after your push → "Address ada's changes". If all have → "ada to re-review" (their move).
7. Pending reviewers, users before teams → "Waiting on sol and 1 more".
8. Not a draft and `reviewDecision === APPROVED` → "Merge, it is approved". This is your move but never urgent.
9. Else **none**.

Gaps for an author: no "request a review" or "mark ready" move (rule 9 swallows it). No CI move. No conflict move. Bot threads are dropped. No idle or stale-age signal: the only age rule is retiring a *topic* after 2 days without human activity once all its PRs are closed.

## Borrow / avoid, mapped to Michael's questions

| Michael's question | Borrow | Avoid |
|---|---|---|
| **What needs my attention?** | The `WhoseTurn` shape `{kind, who, what, move}`. One pure "first match wins" rule list. The tile takes its most urgent member. A worded "your move" chip with "+N" (`P/apps/desktop/src/renderer/src/lib/your-move.ts`). Sections ordered by move urgency. | Topics as the top-level structure. All of Michael's PRs are his own, so grouping by repo or stack is enough. Notification unread state as the source of attention. |
| **Do I need to move it forward?** | The own-PR rules 1–8 above, close to verbatim. | Rule 9's `none` for own PRs. Replace it with explicit moves: draft → "Mark ready / request review", open with no reviewers → "Request review", CI failing → "Fix CI" (for an author CI *is* their move: Postpile's own reason for dropping CI is "it's always the responsibility of the author to bring the PR to green"), conflicts → "Resolve conflicts". |
| **Do I need to address review comments?** | `threadsWaitingOnViewer` (unresolved thread, last comment not yours). `standingChanges` / `reReviewAsked` / `pushedAfter` from `changes-answered.ts`, ported as-is. Push-counts-as-answer from `lastTouch` (`P/packages/core/src/last-touch.ts`). | The `isBot(last.author)` skip. Count bot threads too, but report them separately ("2 human, 3 bot threads"). Also fetch `isOutdated` on threads. |
| **Which threads are linked?** | Nothing to port. Postpile only reads `~/.claude` sessions for a background digest. The MCP idea is worth keeping for later: agents call `pr_context` / `whats_on_me` before they act. | Reading Claude Code session files. T3 owns its threads, so link by PR URL or branch. |
| **Did adversarial reviews find anything?** | The bot regex (`botLogin` / `botBody` in `P/packages/core/src/bots.ts`), used to *label* reviewers as bot or agent. Approval provenance: `standingApprovals` / `agentOnlyApprovers` (`P/packages/core/src/approvals.ts`) → "Approved by agent" vs a person. | "Handled quietly" auto mark-read of bot-only activity. Excluding bot reviews from moves. Michael wants these findings, not hidden. |
| **What state is it in (draft → reviewed → ready)?** | `PrStatus` lifecycle `open / draft / queued / merged / closed` + review word (`P/packages/core/src/pr-status.ts`). Draft tiles look muted and dashed. Merge-queue parsing (`P/packages/core/src/merge-queue.ts`) if Trunk matters. | Treating `reviewDecision` as the whole story. Build a refinement ladder from facts Postpile lacks: CI, mergeability, human vs bot reviews, unresolved threads, and qa-swarm/adversarial runs. |
| **Merge risk?** | Risk line format "low/medium/high - reason" and its parser `glanceRiskLevel` (`P/packages/core/src/glance-risk.ts`). Show the box only when risk is above low. Glance cache keyed on an input hash, rewritten only when the PR moves. `glanceStateOf` states. Stale wording "· out of date" / "· updating" (`P/apps/desktop/src/renderer/src/lib/staleness.ts`). | Reviewer-oriented verdicts (`LOOKS_SAFE` = "a reviewer could approve"). For own PRs the question is "is it ready to merge", not "can I approve". Leaving CI and conflicts out of risk. |
| **Next action?** | Exact sentence templates: "Answer 3 threads from mira", "Address ada's changes", "ada to re-review", "Waiting on sol and 1 more", "Merge, it is approved", "Re-submit to the merge queue: <reason>". A toast that leaves a move open says so: "Marked read. Still your move: …". | The writes lock, approve, and comment drafting. Those are reviewer actions. Michael's next action is "start a thread with a preset". |

### Cross-cutting: borrow

- **One home per fact** (`P/DESIGN.md` "Rules layer" L5907). Every derived fact is one pure function in core, and every consumer (UI, MCP, notifications) reads the same result. It is a projection over PR history, not a state machine: "No XState, no rule engine". For T3: put the classifier in one pure module under `apps/server/src/fork` (or `packages/shared`), shipped to the client as data.
- **Quota discipline**: the `ok/low/critical` levels at 50%/20%, obeying `X-Poll-Interval`, the 6-batch cap, the `updatedAt` freshness pre-check, and query caps with `capHits` so we never claim "0 threads" when the list was cut off.
- **Fake/sample-data mode** for building UI (`POSTPILE_FAKE=1`, `P/apps/server/src/fake/`).
- **Snooze conditions** for later: until reply, until new push, until CI green, until a time (`P/packages/core/src/snooze.ts`). That is also the way out for a "dismiss" state.

### Cross-cutting: avoid

- Agent clustering at scale. One simulated start made 150 topics for about 260 PRs, 109 of them with one PR (`P/DESIGN.md` L47). It is costly and hard to trust.
- Notifications as the source of truth, and mark-read write-back to GitHub. Michael's set is "open PRs I authored", which one GraphQL `viewer.pullRequests(states: OPEN)` plus the batched `prData` fetch covers.
- A 6,400-line spec of per-case exceptions. Most of it handles reviewer edge cases (team routing, home teams, quiet reads) that an author dashboard does not need.

## Rules worth porting verbatim

| Rule | Source | Port note |
|---|---|---|
| `ownPrTurn`, `queueTurn`, own branch of `draftTurn`, `waitingOn` | `P/packages/core/src/whose-turn.ts` | Add the missing moves (request review, mark ready, fix CI, resolve conflicts) before the `NO_TURN` fallthrough |
| `threadsWaitingOnViewer` | same file | Drop the `isBot` skip, split the count into human and bot |
| `isUnansweredAsk` / `lastTouch` (a push answers an ask on your own PR) | `whose-turn.ts`, `P/packages/core/src/last-touch.ts` | As is |
| `standingChanges`, `reReviewAsked`, `pushedAfter` | `P/packages/core/src/changes-answered.ts` | As is |
| `newestVerdictBy`, `changesRequestedByAll`, `isVerdict` | `P/packages/core/src/review-request.ts` | As is |
| `isBot` regex + `botBody` | `P/packages/core/src/bots.ts` | Use to classify, not to drop. Extend with Michael's reviewers |
| `standingApprovals`, `agentOnlyApprovers` | `P/packages/core/src/approvals.ts` | As is |
| `glanceRiskLevel` | `P/packages/core/src/glance-risk.ts` | As is |
| `glanceStateOf` | `P/packages/core/src/glance-state.ts` | Rename for judged fields |
| `rateLimitOf`, `quotaLevel` | `P/packages/github/src/http.ts`, `P/packages/core/src/github-quota.ts` | As is |
| `prData` fragment | `P/packages/github/src/queries.ts` | Add `mergeable mergeStateStatus`, thread `isOutdated`; drop `DEPLOYED_EVENT` |
| `mergeQueueState` | `P/packages/core/src/merge-queue.ts` | Only if PostHog's Trunk queue matters to Michael. It does for PostHog/posthog |
