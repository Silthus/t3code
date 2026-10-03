You review a pull request. You did not write it. Review only: do not edit
files, commit, push, or post to GitHub.

Goal: Ticket Silthus/t3code#15 "Triage contracts and classifier". Build packages/contracts/src/forkTriage.ts with the schemas from the spec's contract sketch (names binding), exported by one line in packages/contracts/src/index.ts, and a pure server classifier apps/server/src/fork/triage/classify.ts: classifyTriage(facts, viewer, now) implementing status rows S1-S9 verbatim from audit-prs classify(pr, null) (Jev dropped), Postpile group overlay G1-G10, refinement L1-L4, blockers, reasons, open questions, signals() (14-day stale), and three counts. A server-internal TriageFacts type (facts.types.ts) matches the spec's Facts list (audit-prs PrFacts trimmed; threads include resolved ones). Tests: classifyTriage with plain fixtures. Nothing reads GitHub yet. The repo's coding rules are in AGENTS.md at the repo root (worktree /home/coder/dev/wf-triage/wt-15). Michael's preferences: keep it simple, YAGNI, type safety, small self-explaining functions, no comment noise, tests outside-in and of the same quality as the code.
Base: origin/main. Head: ee57eb085021bf38a74ed283d2b2d4ae83807711. The diff is below.
Danger areas: public contract names in packages/contracts/src/forkTriage.ts (later tickets build on them); first-match rule order in classify.ts statusStep and turnOf.
Settled: The author recorded these calls; raise them only if they are wrong by the spec, not as taste: (1) answerThreads names the newest awaiting thread's lastAuthor (who is owed a reply) rather than the first-comment author; (2) reReview names up to two people, waitingOn one, matching the spec's examples; (3) drafts list hard and thread blockers without the change-request entry; (4) behindBy dropped from TriageFacts (always null in this design); (5) now is epoch ms; (6) extra named export TriageCounts.

Read each changed hunk with its surrounding code, callers, and types before
you judge it. Report a finding only when you can name its concrete trigger and
its concrete consequence under intended use. When one cause breaks the same
rule at more than one site, report it once and list every site.

Style counts when it breaks a named standard: the repo's documented rules or
the Coding preferences in AGENTS.md. Taste without a standard is not a
finding.

End with:

FINDINGS:
- <file>:<line> | <blocker|major|minor|nit> | <lens> | <trigger> -> <consequence> | <fix> | sites: <file:line, ...>
(or "(none)")
COVERED: <every changed file you cleared or flagged>

You are done when every changed file is cleared or flagged against every
hunting ground of your lens.

## Spec excerpt (the oracle): spec/triage.md, Domain model through Contracts

## Domain model

### Glossary

| Term | Meaning |
|---|---|
| **Triage PR** | An open, non-archived PR on github.com whose author is the viewer. Keyed by `ThreadPullRequestKey` `{host, repository, number}` (`packages/contracts/src/orchestration.ts:776`), the same key thread links use. |
| **Viewer** | The `gh` login of the environment that runs the triage service (`viewer { login }` in the same GraphQL query). On the Mac this is Michael. |
| **PR facts** | Everything known about a triage PR from GitHub alone, with no model involved. A port of audit-prs `PrFacts`, trimmed to what the bulk query reads (see [Facts](#facts)). |
| **Thread (review)** | A GitHub review thread. Its **author** is the author of its first comment. It **awaits the author** when its last comment is not the viewer's (`awaitingAuthor = lastAuthor !== viewer`, audit-prs). |
| **Bot** | `__typename === "Bot"`, or a login ending in `[bot]`, or a `KNOWN_BOTS` login (audit-prs `facts.ts` `isBot`). Bots are labelled, never dropped. |
| **Finding** | An unresolved (open) or resolved review thread whose author is a bot. CodeRabbit, the Codex connector, and other review bots produce findings. |
| **Status** | The audit-prs status, most urgent first: `blocked`, `changes-requested`, `ready-to-merge`, `waiting-ci-authorization`, `waiting-ci`, `ready-for-review`, `draft`. Output of `classify()`. |
| **Group** | Whose move it is: `needs-you`, `ready-to-merge`, `waiting-on-others`, `drafts`. The "needs me" rule is `group === "needs-you"`. Output of the group overlay. |
| **Next action** | One short imperative sentence, the move for whoever's turn it is. |
| **Blocker** | A reason the PR can't merge now: a hard blocker (conflicts, failing CI, Trunk removal), a standing change request, or unanswered human threads. A list. |
| **Reasons** | The audit-prs `reasons` list: why the status is what it is ("Approved by ada", "CI green"). Shown in the detail pane. |
| **Signals** | audit-prs `signals()`: status-independent warnings (stale for 14+ days, conflicts, threads awaiting the author, a Trunk message). |
| **Open questions** | audit-prs `openQuestions`: judgement calls the rules can't make (do these human threads ask for changes? are these bot findings real?). Shown as a badge in the detail pane. |
| **Refinement level** | How far the PR has been reviewed: `raw` → `self-reviewed` → `human-reviewed` → `approved`. |
| **Judgement** | The model's verdict for one head SHA: `risk` (`low`/`medium`/`high`, high is risky), `riskReason` (one line), `summary` (one line, what the PR does), and the `basis` it read. |
| **Judgement state** | `ready`, `pending`, `not-requested` (a draft nobody assessed), `unavailable` (the text-generation provider can't judge), or `failed`. |
| **Linked thread** | A T3 thread on any connected environment whose visible `pullRequests` links (or `branchPullRequest`) match the triage PR's key. Tagged with its environment. |
| **Triage environment** | The environment whose server runs the triage service: the primary (local) environment, else the first connected one. On the Mac that is the bundled fork server. |

### Facts

Per PR, decoded from the bulk query (see [GitHub read](#github-read)):

- Identity: `key`, `url`, `title`, `isDraft`, `headSha`, `baseRef`, `headRef`, `createdAt`, `updatedAt`, `lastPushAt` (head commit `committedDate`, else `updatedAt`), `additions`, `deletions`, `changedFiles`.
- Review: `review` (`approved | changes-requested | review-required | none` from `reviewDecision`), `approvers` and `changeRequesters` (from `latestOpinionatedReviews`, with an `isBot` flag each), `requestedReviewers` (users before teams).
- `mergeable`: `MERGEABLE | CONFLICTING | UNKNOWN`. No `mergeStateStatus` (it causes 502s, #8).
- `ci`: audit-prs `ciFacts` verbatim: `{state, failing[], cancelled[], pending[], awaitingAuthorization, passed}`.
- `trunk`: audit-prs `trunkFacts` verbatim, read from the last 10 top-level comments.
- `threads`: **all** review threads, resolved included, each `{isResolved, isOutdated, path, author, authorIsBot, lastAuthor, lastAt, awaitingAuthor}`. `threadsTruncated` is true when `reviewThreads.totalCount > 50`.
- `humanComments`: top-level comments from humans other than the viewer, the last 8 (audit-prs).

Derived counts:

- `humanThreadsAwaiting`: unresolved, human author, `awaitingAuthor` (outdated included, as in audit-prs `signals()`).
- `botFindingsOpen`: unresolved, bot author.
- `botFindingsResolved`: resolved, bot author.

`behindBy` stays `null`: it needs a per-PR compare and is out of the bulk read (#8). `signals()` already handles `null`.

## Classification rules

One pure module, `apps/server/src/fork/triage/classify.ts`. It is a projection over facts, not a state machine. Three steps run in order: status (audit-prs, verbatim), group overlay (Postpile own-PR rules, folded in), refinement.

Shared values, from audit-prs `classify.ts`:

- `humanWaiting` = threads unresolved, `!authorIsBot`, `awaitingAuthor`, `!isOutdated`.
- `botWaiting` = threads unresolved, `authorIsBot`, `awaitingAuthor`, `!isOutdated`.
- `hardBlockers`, in order: `mergeable === "CONFLICTING"` → "Resolve merge conflicts"; `ci.state === "failing"` → "Fix failing CI: <first 3 failing names, comma-joined>"; `trunk.failed` → "Trunk removed the PR from the merge queue".
- `threadBlockers`: `humanWaiting > 0` → "Address N unresolved reviewer thread(s)".

### Step 1: status and next action (audit-prs `classify(pr, null)`, verbatim)

Source: `~/.claude/skills/audit-prs/scripts/classify.ts` `classify()`, run with `jev = null`. The Jev branches are dropped because nothing supplies Jev answers (see Calls made). First match wins.

| # | When | Status | Next action |
|---|---|---|---|
| S1 | `isDraft` | `draft` | "Finish the implementation" |
| S2 | `review === "changes-requested"` | `changes-requested` | `hardBlockers[0]` ?? "Address the review feedback" |
| S3 | `hardBlockers` not empty | `blocked` | `hardBlockers[0]` |
| S4 | `humanWaiting > 0` | `changes-requested` | `threadBlockers[0]` |
| S5 | `review === "approved"` and `ci.state === "awaiting-authorization"` | `waiting-ci-authorization` | "Ask a maintainer to authorize the CI run" |
| S6 | `review === "approved"` and `ci.state === "cancelled"` | `waiting-ci` | "Re-run CI, the last runs were cancelled" |
| S7 | `review === "approved"` and `ci.state` is `pending` or `none` | `waiting-ci` | "Wait for CI to finish" |
| S8 | `review === "approved"` | `ready-to-merge` | `merge` = `trunk.managed` ? "Comment /trunk merge" : "Merge it". When `botWaiting > 0`: "Judge the bot findings, then " + lowercased `merge` |
| S9 | otherwise | `ready-for-review` | `ci.state` `awaiting-authorization` → "Ask for review and CI authorization"; `cancelled` → "Re-run CI, then ask for review"; else "Ask for review" |

`reasons` and `openQuestions` are built exactly as in `classify()` with `jev = null`:

- Open question "Do the unanswered human threads or comments ask for changes?" when `humanWaiting > 0` or `humanComments` is not empty.
- "Judge N unanswered bot finding(s): real defect or noise?" when `botWaiting > 0`.
- "Does the description read as a finished change?" for every draft.

`blockers` = (S2 only: "Changes requested by <changeRequesters or 'a reviewer'>") + `hardBlockers` + `threadBlockers`. It is empty for `ready-to-merge`, `waiting-ci*`, and `ready-for-review` when nothing blocks.

`signals` = audit-prs `signals(pr, now)` verbatim (`STALE_DAYS = 14`).

### Step 2: group and next-action overlay (Postpile own-PR rules)

Source: Postpile `packages/core/src/whose-turn.ts` `ownPrTurn`/`draftTurn`/`waitingOn` and `changes-answered.ts` `reReviewAsked` at `67a2b82` (MIT; keep the notice in the file header). First match wins. Where a row says "keep", the next action from step 1 stands.

| # | When | Group | Next action |
|---|---|---|---|
| G1 | status `draft` | `drafts` | `humanWaiting > 0` → `answerThreads`, else keep |
| G2 | status `blocked` | `needs-you` | keep |
| G3 | status `changes-requested`, `hardBlockers` empty, `humanWaiting === 0`, `review === "changes-requested"`, `changeRequesters` not empty, and every change requester is in `requestedReviewers` | `waiting-on-others` | `reReview`: "ada to re-review" / "ada and sol to re-review" / "ada and 2 more to re-review" |
| G4 | status `changes-requested` | `needs-you` | `hardBlockers` empty and `humanWaiting > 0` → `answerThreads`, else keep |
| G5 | status `ready-to-merge` | `ready-to-merge` | keep |
| G6 | status `waiting-ci-authorization` | `waiting-on-others` | keep |
| G7 | status `waiting-ci` and `ci.state === "cancelled"` | `needs-you` | keep |
| G8 | status `waiting-ci` | `waiting-on-others` | keep |
| G9 | status `ready-for-review`, `requestedReviewers` not empty, `ci.state` not `awaiting-authorization` or `cancelled` | `waiting-on-others` | `waitingOn`: "Waiting on sol" / "Waiting on sol and 1 more" |
| G10 | status `ready-for-review` | `needs-you` | keep |

Templates (Postpile wording):

- `answerThreads`: "Answer N thread(s) from <author of the newest awaiting thread>" plus " and M more" when several humans wrote them.
- `reReview`, `waitingOn`: names in order, users before teams, first one or two named, then "and N more".

Not folded in, and why:

- Postpile's "unanswered ask" rule needs every comment and push in order. The bulk read keeps the last 10 comments for Trunk and open questions only. The unanswered human comments surface as the existing open question.
- Postpile's merge-queue rule needs timeline events. Trunk is covered by audit-prs `trunkFacts`. GitHub's native merge queue is YAGNI until Michael's repos use it.

### Step 3: refinement level

First match wins.

| # | When | Level |
|---|---|---|
| L1 | `review === "approved"` | `approved` |
| L2 | an opinionated review, or any review thread (resolved or not), is by a human other than the viewer | `human-reviewed` |
| L3 | an opinionated review, or any review thread (resolved or not), is by a bot | `self-reviewed` |
| L4 | otherwise | `raw` |

The UI labels: Raw, Self-reviewed, Human-reviewed, Approved.

## Contracts

New file `packages/contracts/src/forkTriage.ts`, exported by one line in `packages/contracts/src/index.ts`. The HTTP group is added by the slice that adds its server handler, because an `EnvironmentHttpApi` group without a handler fails the server build.

Sketch (Effect Schema; names are binding, details are the implementer's):

```ts
// packages/contracts/src/forkTriage.ts
export const TRIAGE_STATUSES = ["blocked", "changes-requested", "ready-to-merge",
  "waiting-ci-authorization", "waiting-ci", "ready-for-review", "draft"] as const;
export const TriageStatus = Schema.Literals(TRIAGE_STATUSES);
export const TRIAGE_GROUPS = ["needs-you", "ready-to-merge", "waiting-on-others", "drafts"] as const;
export const TriageGroup = Schema.Literals(TRIAGE_GROUPS);
export const TriageRefinement = Schema.Literals(["raw", "self-reviewed", "human-reviewed", "approved"]);
export const TriageCiState = Schema.Literals(["green", "pending", "awaiting-authorization", "cancelled", "failing", "none"]);
export const TriageReviewState = Schema.Literals(["approved", "changes-requested", "review-required", "none"]);
export const TriageMergeable = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
export const TriageRisk = Schema.Literals(["low", "medium", "high"]);
export const TriageJudgementBasis = Schema.Literals(["full diff", "diff excerpt", "file list"]);

export const TriageJudgement = Schema.Struct({
  risk: TriageRisk,
  riskReason: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  basis: TriageJudgementBasis,
  headSha: TrimmedNonEmptyString,
  judgedAt: IsoDateTime,
});

export const TriageJudgementState = Schema.Union([
  Schema.TaggedStruct("ready", { judgement: TriageJudgement }),
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("not-requested", {}),
  Schema.TaggedStruct("unavailable", { reason: Schema.String }),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
]);

export const TriagePullRequest = Schema.Struct({
  key: ThreadPullRequestKey,                 // {host, repository, number}
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  headSha: TrimmedNonEmptyString,
  baseRef: Schema.String,
  headRef: Schema.String,
  updatedAt: IsoDateTime,
  lastPushAt: IsoDateTime,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  review: TriageReviewState,
  ci: Schema.Struct({ state: TriageCiState, failing: Schema.Array(Schema.String) }),
  mergeable: TriageMergeable,
  requestedReviewers: Schema.Array(Schema.String),
  status: TriageStatus,
  group: TriageGroup,
  nextAction: TrimmedNonEmptyString,
  blockers: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  signals: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  refinement: TriageRefinement,
  counts: Schema.Struct({
    humanThreadsAwaiting: NonNegativeInt,
    botFindingsOpen: NonNegativeInt,
    botFindingsResolved: NonNegativeInt,
    threadsTruncated: Schema.Boolean,
  }),
  judgement: TriageJudgementState,
});

export const TriageReport = Schema.Struct({
  viewer: Schema.String,
  fetchedAt: Schema.NullOr(IsoDateTime),     // last successful GitHub read
  error: Schema.NullOr(Schema.String),       // last read failed; pullRequests are the last good ones
  pullRequests: Schema.Array(TriagePullRequest),
});

export const TriageReportInput = Schema.Struct({ refresh: Schema.Boolean });
export const TriageAssessInput = ThreadPullRequestKey;

// packages/contracts/src/environmentHttp.ts (one appended block, prior-branch pattern)
class EnvironmentForkTriageHttpApi extends HttpApiGroup.make("forkTriage")
  .add(HttpApiEndpoint.post("report", "/api/fork/triage/report", {
    headers: OptionalBearerHeaders, payload: TriageReportInput, success: TriageReport,
    error: [EnvironmentScopeRequiredError, EnvironmentInternalError],
  }).middleware(EnvironmentAuthenticatedAuth))
  .add(HttpApiEndpoint.post("assess", "/api/fork/triage/assess", {
    headers: OptionalBearerHeaders, payload: TriageAssessInput, success: TriageJudgementState,
    error: [EnvironmentScopeRequiredError, EnvironmentInternalError],
  }).middleware(EnvironmentAuthenticatedAuth)) {}
```

Upstream hook in `packages/contracts/src/environmentHttp.ts`: the group block above (about 16 lines, it needs the module-private `OptionalBearerHeaders`), one import of the fork schemas, and one `.add(EnvironmentForkTriageHttpApi)` on `EnvironmentHttpApi`. The GitHub-read slice adds the group with `report` only; the judgement slice adds `assess`. Until then the report sets every `judgement` to `unavailable` ("Risk judgement is not built yet"). Defining the group in a fork file would need `environmentHttp.ts` and the fork file to import each other. The prior branch did the same (`origin/t3code/build-github-pr-monitor`, `environmentHttp.ts` +18).


## Port source: audit-prs scripts/classify.ts (verbatim reference)
```ts
// Combines deterministic facts with Jev's hints into one status, a next
// action, and signals. Rules decide first. Jev refines the cases GitHub's data
// cannot tell; without Jev those cases become open questions for the agent.
// Merge confidence comes from `risk.ts` and is only attached here.

import type { Confidence, JevAnswers, PrFacts, Status, TriagedPr } from './types';

const YES = 0.7;
/** Drafts get a softer threshold: authors rarely write "done" in a draft description. */
const DRAFT_DONE = 0.5;
/** A PR without a push for this long has likely drifted from its base. */
export const STALE_DAYS = 14;
const DAY_MS = 86_400_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function daysSince(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / DAY_MS);
}

export const isStale = (pr: PrFacts, now: number) => daysSince(pr.lastPushAt, now) >= STALE_DAYS;

interface Classification {
  status: Status;
  draftFinished: boolean;
  nextAction: string;
  reasons: string[];
  openQuestions: string[];
}

export function classify(pr: PrFacts, jev: JevAnswers | null): Classification {
  const reasons: string[] = [];
  const openQuestions: string[] = [];
  const humanWaiting = pr.threads.filter((t) => !t.authorIsBot && t.awaitingAuthor && !t.isOutdated).length;
  const botWaiting = pr.threads.filter((t) => t.authorIsBot && t.awaitingAuthor && !t.isOutdated).length;

  // Without Jev, an unanswered human thread counts as a change request. Bot findings never block on their own.
  let humanChanges: boolean;
  if (jev?.humanChangesPending != null) humanChanges = jev.humanChangesPending >= YES;
  else {
    humanChanges = humanWaiting > 0;
    if (humanWaiting || pr.humanComments.length) openQuestions.push('Do the unanswered human threads or comments ask for changes?');
  }
  let botFindings = false;
  if (jev?.botFindingsSubstantive != null) botFindings = jev.botFindingsSubstantive >= YES;
  else if (botWaiting) openQuestions.push(`Judge ${plural(botWaiting, 'unanswered bot finding')}: real defect or noise?`);

  if (pr.isDraft) {
    const draftFinished = (jev?.draftFinished ?? 0) >= DRAFT_DONE;
    if (!jev) openQuestions.push('Does the description read as a finished change?');
    reasons.push(draftFinished ? 'Description reads as finished' : 'Implementation still in progress');
    return {
      status: 'draft',
      draftFinished,
      nextAction: draftFinished ? 'Validate and mark ready for review' : 'Finish the implementation',
      reasons,
      openQuestions,
    };
  }

  // Hard blockers come from GitHub facts. Jev only adds the judgement calls.
  const hardBlockers: string[] = [];
  if (pr.mergeable === 'CONFLICTING') hardBlockers.push('Resolve merge conflicts');
  if (pr.ci.state === 'failing') hardBlockers.push(`Fix failing CI: ${pr.ci.failing.slice(0, 3).join(', ')}`);
  if (pr.trunk.failed) hardBlockers.push('Trunk removed the PR from the merge queue');
  const threadBlockers: string[] = [];
  if (humanChanges) threadBlockers.push(`Address ${plural(humanWaiting || pr.threads.filter((t) => !t.authorIsBot).length, 'unresolved reviewer thread')}`);
  if (botFindings) threadBlockers.push(`Check ${plural(botWaiting, 'automated finding')}`);
  const result = (status: Status, nextAction: string, why: string[]): Classification =>
    ({ status, draftFinished: false, nextAction, reasons: why, openQuestions });

  if (pr.review === 'changes-requested') {
    reasons.push(`Changes requested by ${pr.changeRequesters.join(', ') || 'a reviewer'}`);
    return result('changes-requested', hardBlockers[0] ?? 'Address the review feedback', [...reasons, ...hardBlockers, ...threadBlockers]);
  }
  if (hardBlockers.length) return result('blocked', hardBlockers[0]!, [...hardBlockers, ...threadBlockers]);
  if (humanChanges) return result('changes-requested', threadBlockers[0]!, ['A reviewer asked for changes in a thread', ...threadBlockers]);
  if (botFindings) return result('blocked', threadBlockers[0]!, threadBlockers);

  if (pr.review === 'approved') {
    reasons.push(`Approved by ${pr.approvers.join(', ') || 'a reviewer'}`);
    if (pr.ci.state === 'awaiting-authorization') {
      return result('waiting-ci-authorization', 'Ask a maintainer to authorize the CI run', [...reasons, `${plural(pr.ci.awaitingAuthorization, 'workflow')} need authorization`]);
    }
    if (pr.ci.state === 'cancelled') {
      return result('waiting-ci', 'Re-run CI, the last runs were cancelled', [...reasons, `${plural(pr.ci.cancelled.length, 'check')} cancelled`]);
    }
    if (pr.ci.state === 'pending' || pr.ci.state === 'none') {
      return result('waiting-ci', 'Wait for CI to finish', [...reasons, pr.ci.pending.length ? `${plural(pr.ci.pending.length, 'check')} running` : 'No check results yet']);
    }
    if (pr.mergeable === 'UNKNOWN') reasons.push('Mergeability not computed yet');
    const merge = pr.trunk.managed ? 'Comment /trunk merge' : 'Merge it';
    // Unjudged bot findings could still hide a defect, so the merge waits for the agent's verdict.
    const nextAction = !jev && botWaiting ? `Judge the bot findings, then ${merge.toLowerCase()}` : merge;
    return result('ready-to-merge', nextAction, [...reasons, 'CI green']);
  }

  // Not approved, nothing blocking: it needs a reviewer.
  reasons.push('No current approval');
  if (pr.ci.state === 'awaiting-authorization') reasons.push('CI also needs authorization');
  if (pr.ci.state === 'pending') reasons.push('CI running');
  if (pr.ci.state === 'cancelled') reasons.push('CI runs were cancelled');
  const nextAction = pr.ci.state === 'awaiting-authorization' ? 'Ask for review and CI authorization'
    : pr.ci.state === 'cancelled' ? 'Re-run CI, then ask for review'
    : 'Ask for review';
  return result('ready-for-review', nextAction, reasons);
}

/** Status-independent warnings: drift from the base branch and unanswered threads. */
export function signals(pr: PrFacts, now: number): string[] {
  const out: string[] = [];
  const behind = pr.behindBy === null ? '' : `, ${pr.behindBy} commits behind ${pr.baseRef}`;
  if (isStale(pr, now)) out.push(`Stale: last push ${daysSince(pr.lastPushAt, now)} days ago${behind}. Modernize candidate`);
  else if (pr.mergeable === 'CONFLICTING') out.push(`Conflicts with ${pr.baseRef}${behind}`);
  const human = pr.threads.filter((t) => !t.authorIsBot && t.awaitingAuthor).length;
  const bot = pr.threads.filter((t) => t.authorIsBot && t.awaitingAuthor).length;
  if (human) out.push(`${plural(human, 'human thread')} awaiting the author's reply`);
  if (bot) out.push(`${plural(bot, 'bot thread')} awaiting the author's reply`);
  if (pr.trunk.message) out.push(`Trunk: ${pr.trunk.message}`);
  return out;
}

/** Joins the classification with the agent's merge confidence from `risk.ts`. */
export function triage(pr: PrFacts, jev: JevAnswers | null, confidence: Confidence, now: number): TriagedPr {
  const c = classify(pr, jev);
  return { facts: pr, ...c, signals: signals(pr, now), confidence, jev };
}
```

## Port source: Postpile packages/core/src/whose-turn.ts is at /home/coder/dev/wf-triage/postpile/packages/core/src/whose-turn.ts (ownPrTurn, draftTurn, waitingOn) if you can read it.

## Diff
```diff
diff --git a/apps/server/src/fork/triage/classify.test.ts b/apps/server/src/fork/triage/classify.test.ts
new file mode 100644
index 000000000..c77f19ebd
--- /dev/null
+++ b/apps/server/src/fork/triage/classify.test.ts
@@ -0,0 +1,345 @@
+import { describe, expect, it } from "vite-plus/test";
+
+import { classifyTriage } from "./classify.ts";
+import type { TriageFacts, TriageThreadFacts } from "./facts.types.ts";
+
+const VIEWER = "me";
+const NOW = Date.parse("2026-09-23T00:00:00Z");
+
+function facts(overrides: Partial<TriageFacts> = {}): TriageFacts {
+  return {
+    key: { host: "github.com", repository: "o/r", number: 1 },
+    url: "https://github.com/o/r/pull/1",
+    title: "t",
+    isDraft: false,
+    headSha: "abc",
+    baseRef: "master",
+    headRef: "feat",
+    createdAt: "2026-09-01T00:00:00Z",
+    updatedAt: "2026-09-22T00:00:00Z",
+    lastPushAt: "2026-09-22T00:00:00Z",
+    additions: 10,
+    deletions: 2,
+    changedFiles: 1,
+    review: "review-required",
+    approvers: [],
+    changeRequesters: [],
+    requestedReviewers: [],
+    mergeable: "MERGEABLE",
+    ci: {
+      state: "green",
+      failing: [],
+      cancelled: [],
+      pending: [],
+      awaitingAuthorization: 0,
+      passed: 5,
+    },
+    trunk: { managed: true, failed: false, message: null },
+    threads: [],
+    threadsTruncated: false,
+    humanComments: [],
+    ...overrides,
+  };
+}
+
+const humanThread: TriageThreadFacts = {
+  isResolved: false,
+  isOutdated: false,
+  path: "a.ts",
+  author: "alice",
+  authorIsBot: false,
+  lastAuthor: "alice",
+  lastAt: "2026-09-22T00:00:00Z",
+  awaitingAuthor: true,
+};
+const botThread: TriageThreadFacts = {
+  ...humanThread,
+  author: "coderabbitai",
+  authorIsBot: true,
+  lastAuthor: "coderabbitai",
+};
+const resolved = (thread: TriageThreadFacts): TriageThreadFacts => ({
+  ...thread,
+  isResolved: true,
+});
+const human = (login: string) => ({ login, isBot: false });
+
+const classify = (overrides: Partial<TriageFacts> = {}) =>
+  classifyTriage(facts(overrides), VIEWER, NOW);
+const ci = (overrides: Partial<TriageFacts["ci"]>) => ({ ...facts().ci, ...overrides });
+
+describe("status (audit-prs classify without Jev)", () => {
+  it("counts a human thread that awaits the author's reply as a change request and asks to confirm", () => {
+    const result = classify({ threads: [humanThread] });
+    expect(result.status).toBe("changes-requested");
+    expect(result.openQuestions.join(" ")).toMatch(/ask for changes/);
+  });
+
+  it("does not block on a human thread the author answered last", () => {
+    const answered = { ...humanThread, lastAuthor: VIEWER, awaitingAuthor: false };
+    expect(classify({ threads: [answered] }).status).toBe("ready-for-review");
+  });
+
+  it("never blocks on bot findings alone and leaves them to judge", () => {
+    const result = classify({ review: "approved", threads: [botThread] });
+    expect(result.status).toBe("ready-to-merge");
+    expect(result.openQuestions).toEqual(["Judge 1 unanswered bot finding: real defect or noise?"]);
+    expect(result.nextAction).toBe("Judge the bot findings, then comment /trunk merge");
+  });
+
+  it("never calls a draft finished", () => {
+    const result = classify({ isDraft: true });
+    expect(result.nextAction).toBe("Finish the implementation");
+    expect(result.openQuestions).toContain("Does the description read as a finished change?");
+  });
+
+  it("puts conflicts before everything except an explicit changes-requested review", () => {
+    expect(classify({ review: "approved", mergeable: "CONFLICTING" }).status).toBe("blocked");
+    expect(classify({ review: "changes-requested", mergeable: "CONFLICTING" }).status).toBe(
+      "changes-requested",
+    );
+  });
+
+  it("gives approved PRs whose CI waits for a maintainer their own status", () => {
+    const result = classify({
+      review: "approved",
+      ci: ci({ state: "awaiting-authorization", awaitingAuthorization: 12, passed: 0 }),
+    });
+    expect(result.status).toBe("waiting-ci-authorization");
+  });
+
+  it("ignores resolved threads", () => {
+    expect(classify({ threads: [resolved(humanThread)] }).status).toBe("ready-for-review");
+  });
+
+  it("lists the change request, hard blockers, and thread blockers as blockers", () => {
+    const result = classify({
+      review: "changes-requested",
+      changeRequesters: [human("ada")],
+      ci: ci({ state: "failing", failing: ["lint", "test", "build", "e2e"] }),
+      threads: [humanThread],
+    });
+    expect(result.blockers).toEqual([
+      "Changes requested by ada",
+      "Fix failing CI: lint, test, build",
+      "Address 1 unresolved reviewer thread",
+    ]);
+  });
+
+  it("has no blockers when nothing blocks", () => {
+    expect(classify({ review: "approved" }).blockers).toEqual([]);
+  });
+});
+
+describe("signals", () => {
+  it("calls a PR without a push for two weeks a modernize candidate", () => {
+    expect(classify({ lastPushAt: "2026-09-01T00:00:00Z" }).signals).toEqual([
+      "Stale: last push 22 days ago. Modernize candidate",
+    ]);
+  });
+
+  it("names the conflict on a fresh PR instead", () => {
+    expect(classify({ mergeable: "CONFLICTING" }).signals).toEqual(["Conflicts with master"]);
+  });
+
+  it("counts unresolved threads that await the author's reply by author kind", () => {
+    const threads = [humanThread, botThread, botThread, resolved(humanThread)];
+    expect(classify({ threads }).signals).toEqual([
+      "1 human thread awaiting the author's reply",
+      "2 bot threads awaiting the author's reply",
+    ]);
+  });
+
+  it("repeats Trunk's message", () => {
+    const trunk = { managed: true, failed: true, message: "❌ removed from the merge queue" };
+    expect(classify({ trunk }).signals).toEqual(["Trunk: ❌ removed from the merge queue"]);
+  });
+});
+
+describe("group and next action (Postpile own-PR overlay)", () => {
+  it("G1: keeps drafts apart and asks to answer their threads first", () => {
+    expect(classify({ isDraft: true })).toMatchObject({
+      group: "drafts",
+      nextAction: "Finish the implementation",
+    });
+    expect(classify({ isDraft: true, threads: [humanThread] })).toMatchObject({
+      group: "drafts",
+      nextAction: "Answer 1 thread from alice",
+    });
+  });
+
+  it("G2: puts blocked PRs on the viewer with the first hard blocker", () => {
+    const result = classify({ ci: ci({ state: "failing", failing: ["lint", "test"] }) });
+    expect(result).toMatchObject({
+      status: "blocked",
+      group: "needs-you",
+      nextAction: "Fix failing CI: lint, test",
+    });
+  });
+
+  it("G3: waits on change requesters the viewer asked to re-review", () => {
+    const reReview = (requesters: string[]) =>
+      classify({
+        review: "changes-requested",
+        changeRequesters: requesters.map(human),
+        requestedReviewers: [...requesters, "team-x"],
+      });
+    expect(reReview(["ada"])).toMatchObject({
+      group: "waiting-on-others",
+      nextAction: "ada to re-review",
+    });
+    expect(reReview(["ada", "sol"]).nextAction).toBe("ada and sol to re-review");
+    expect(reReview(["ada", "sol", "kim"]).nextAction).toBe("ada and 2 more to re-review");
+  });
+
+  it("G4: leaves a change request on the viewer until every requester is asked again", () => {
+    const result = classify({
+      review: "changes-requested",
+      changeRequesters: [human("ada"), human("sol")],
+      requestedReviewers: ["ada"],
+    });
+    expect(result).toMatchObject({
+      group: "needs-you",
+      nextAction: "Address the review feedback",
+    });
+  });
+
+  it("G4: asks to answer human threads, naming the newest one's author", () => {
+    const fromBob = {
+      ...humanThread,
+      author: "bob",
+      lastAuthor: "bob",
+      lastAt: "2026-09-22T12:00:00Z",
+    };
+    const result = classify({ threads: [humanThread, humanThread, fromBob] });
+    expect(result).toMatchObject({
+      status: "changes-requested",
+      group: "needs-you",
+      nextAction: "Answer 3 threads from bob and 1 more",
+    });
+  });
+
+  it("G4: names who the viewer owes an answer, not who opened the thread", () => {
+    const viewerOpened = { ...humanThread, author: VIEWER };
+    expect(classify({ threads: [viewerOpened] }).nextAction).toBe("Answer 1 thread from alice");
+  });
+
+  it("G4: keeps a hard blocker as the move on a change request", () => {
+    const result = classify({
+      review: "changes-requested",
+      mergeable: "CONFLICTING",
+      threads: [humanThread],
+    });
+    expect(result).toMatchObject({ group: "needs-you", nextAction: "Resolve merge conflicts" });
+  });
+
+  it("G5: groups approved PRs with green CI as ready to merge", () => {
+    expect(classify({ review: "approved" })).toMatchObject({
+      group: "ready-to-merge",
+      nextAction: "Comment /trunk merge",
+    });
+    expect(
+      classify({ review: "approved", trunk: { managed: false, failed: false, message: null } }),
+    ).toMatchObject({ group: "ready-to-merge", nextAction: "Merge it" });
+  });
+
+  it("G6: waits on a maintainer to authorize CI", () => {
+    const result = classify({ review: "approved", ci: ci({ state: "awaiting-authorization" }) });
+    expect(result).toMatchObject({
+      group: "waiting-on-others",
+      nextAction: "Ask a maintainer to authorize the CI run",
+    });
+  });
+
+  it("G7: puts cancelled CI on the viewer", () => {
+    const result = classify({
+      review: "approved",
+      ci: ci({ state: "cancelled", cancelled: ["test"] }),
+    });
+    expect(result).toMatchObject({
+      status: "waiting-ci",
+      group: "needs-you",
+      nextAction: "Re-run CI, the last runs were cancelled",
+    });
+  });
+
+  it("G8: waits on running CI", () => {
+    const result = classify({
+      review: "approved",
+      ci: ci({ state: "pending", pending: ["test"] }),
+    });
+    expect(result).toMatchObject({
+      status: "waiting-ci",
+      group: "waiting-on-others",
+      nextAction: "Wait for CI to finish",
+    });
+  });
+
+  it("G9: waits on requested reviewers, users before teams", () => {
+    expect(classify({ requestedReviewers: ["sol"] })).toMatchObject({
+      group: "waiting-on-others",
+      nextAction: "Waiting on sol",
+    });
+    expect(classify({ requestedReviewers: ["sol", "team-x"] }).nextAction).toBe(
+      "Waiting on sol and 1 more",
+    );
+  });
+
+  it("G10: asks the viewer to request review", () => {
+    expect(classify()).toMatchObject({ group: "needs-you", nextAction: "Ask for review" });
+    expect(
+      classify({
+        requestedReviewers: ["sol"],
+        ci: ci({ state: "cancelled", cancelled: ["test"] }),
+      }),
+    ).toMatchObject({ group: "needs-you", nextAction: "Re-run CI, then ask for review" });
+  });
+});
+
+describe("refinement", () => {
+  it("L1: approved", () => {
+    expect(classify({ review: "approved", approvers: [human("ada")] }).refinement).toBe("approved");
+  });
+
+  it("L2: human-reviewed once a human other than the viewer reviews or opens a thread", () => {
+    expect(classify({ changeRequesters: [human("ada")] }).refinement).toBe("human-reviewed");
+    expect(classify({ threads: [resolved(humanThread), botThread] }).refinement).toBe(
+      "human-reviewed",
+    );
+  });
+
+  it("L3: self-reviewed when only bots reviewed", () => {
+    expect(classify({ threads: [resolved(botThread)] }).refinement).toBe("self-reviewed");
+    expect(classify({ approvers: [{ login: "codex", isBot: true }] }).refinement).toBe(
+      "self-reviewed",
+    );
+  });
+
+  it("L4: raw when nobody but the viewer reviewed", () => {
+    expect(classify().refinement).toBe("raw");
+    const ownThread = { ...humanThread, author: VIEWER, lastAuthor: VIEWER, awaitingAuthor: false };
+    expect(classify({ threads: [ownThread] }).refinement).toBe("raw");
+  });
+});
+
+describe("counts", () => {
+  it("counts awaiting human threads, outdated included, and open and resolved bot findings", () => {
+    const result = classify({
+      threads: [
+        humanThread,
+        { ...humanThread, isOutdated: true },
+        resolved(humanThread),
+        botThread,
+        resolved(botThread),
+        resolved(botThread),
+      ],
+      threadsTruncated: true,
+    });
+    expect(result.counts).toEqual({
+      humanThreadsAwaiting: 2,
+      botFindingsOpen: 1,
+      botFindingsResolved: 2,
+      threadsTruncated: true,
+    });
+  });
+});
diff --git a/apps/server/src/fork/triage/classify.ts b/apps/server/src/fork/triage/classify.ts
new file mode 100644
index 000000000..d68d513c9
--- /dev/null
+++ b/apps/server/src/fork/triage/classify.ts
@@ -0,0 +1,382 @@
+/*
+ * Status rules ported from the audit-prs skill's classify.ts. The group overlay and its
+ * wording are adapted from Postpile (https://github.com/PostHog/postpile at 67a2b82,
+ * packages/core/src/whose-turn.ts and changes-answered.ts), under this notice:
+ *
+ * MIT License
+ *
+ * Copyright (c) 2026 PostHog Inc.
+ *
+ * Permission is hereby granted, free of charge, to any person obtaining a copy
+ * of this software and associated documentation files (the "Software"), to deal
+ * in the Software without restriction, including without limitation the rights
+ * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
+ * copies of the Software, and to permit persons to whom the Software is
+ * furnished to do so, subject to the following conditions:
+ *
+ * The above copyright notice and this permission notice shall be included in all
+ * copies or substantial portions of the Software.
+ *
+ * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
+ * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
+ * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
+ * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
+ * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
+ * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
+ * SOFTWARE.
+ */
+import type {
+  TriageGroup,
+  TriagePullRequest,
+  TriageRefinement,
+  TriageStatus,
+} from "@t3tools/contracts";
+
+import type { TriageFacts, TriageReviewer, TriageThreadFacts } from "./facts.types.ts";
+
+export type TriageClassification = Pick<
+  TriagePullRequest,
+  | "status"
+  | "group"
+  | "nextAction"
+  | "blockers"
+  | "reasons"
+  | "signals"
+  | "openQuestions"
+  | "refinement"
+  | "counts"
+>;
+
+export const STALE_DAYS = 14;
+const DAY_MS = 86_400_000;
+
+interface PullRequestReading {
+  readonly facts: TriageFacts;
+  readonly humanWaiting: ReadonlyArray<TriageThreadFacts>;
+  readonly botWaiting: number;
+  readonly hardBlockers: ReadonlyArray<string>;
+  readonly threadBlockers: ReadonlyArray<string>;
+}
+
+interface StatusStep {
+  readonly status: TriageStatus;
+  readonly nextAction: string;
+  readonly reasons: ReadonlyArray<string>;
+}
+
+interface Turn {
+  readonly group: TriageGroup;
+  readonly nextAction: string;
+}
+
+export function classifyTriage(
+  facts: TriageFacts,
+  viewer: string,
+  now: number,
+): TriageClassification {
+  const reading = readPullRequest(facts);
+  const step = statusStep(reading);
+  return {
+    status: step.status,
+    ...turnOf(reading, step),
+    blockers: blockersOf(reading, step.status),
+    reasons: step.reasons,
+    signals: signalsOf(facts, now),
+    openQuestions: openQuestionsOf(reading),
+    refinement: refinementOf(facts, viewer),
+    counts: countsOf(facts),
+  };
+}
+
+function readPullRequest(facts: TriageFacts): PullRequestReading {
+  const waiting = openThreads(facts).filter(
+    (thread) => thread.awaitingAuthor && !thread.isOutdated,
+  );
+  const humanWaiting = waiting.filter((thread) => !thread.authorIsBot);
+  return {
+    facts,
+    humanWaiting,
+    botWaiting: waiting.length - humanWaiting.length,
+    hardBlockers: hardBlockersOf(facts),
+    threadBlockers: onlyIf(
+      humanWaiting.length > 0,
+      `Address ${plural(humanWaiting.length, "unresolved reviewer thread")}`,
+    ),
+  };
+}
+
+function hardBlockersOf({ mergeable, ci, trunk }: TriageFacts): ReadonlyArray<string> {
+  return [
+    ...onlyIf(mergeable === "CONFLICTING", "Resolve merge conflicts"),
+    ...onlyIf(ci.state === "failing", `Fix failing CI: ${ci.failing.slice(0, 3).join(", ")}`),
+    ...onlyIf(trunk.failed, "Trunk removed the PR from the merge queue"),
+  ];
+}
+
+function statusStep(reading: PullRequestReading): StatusStep {
+  const { facts, hardBlockers, threadBlockers } = reading;
+  const [hardBlocker] = hardBlockers;
+  const [threadBlocker] = threadBlockers;
+  if (facts.isDraft) {
+    return {
+      status: "draft",
+      nextAction: "Finish the implementation",
+      reasons: ["Implementation still in progress"],
+    };
+  }
+  if (facts.review === "changes-requested") {
+    return {
+      status: "changes-requested",
+      nextAction: hardBlocker ?? "Address the review feedback",
+      reasons: [changesRequestedBy(facts), ...hardBlockers, ...threadBlockers],
+    };
+  }
+  if (hardBlocker) {
+    return {
+      status: "blocked",
+      nextAction: hardBlocker,
+      reasons: [...hardBlockers, ...threadBlockers],
+    };
+  }
+  if (threadBlocker) {
+    return {
+      status: "changes-requested",
+      nextAction: threadBlocker,
+      reasons: ["A reviewer asked for changes in a thread", ...threadBlockers],
+    };
+  }
+  if (facts.review === "approved") return approvedStep(reading);
+  return reviewStep(facts);
+}
+
+function approvedStep({ facts, botWaiting }: PullRequestReading): StatusStep {
+  const { ci } = facts;
+  const approved = `Approved by ${logins(facts.approvers) || "a reviewer"}`;
+  if (ci.state === "awaiting-authorization") {
+    return {
+      status: "waiting-ci-authorization",
+      nextAction: "Ask a maintainer to authorize the CI run",
+      reasons: [approved, `${plural(ci.awaitingAuthorization, "workflow")} need authorization`],
+    };
+  }
+  if (ci.state === "cancelled") {
+    return {
+      status: "waiting-ci",
+      nextAction: "Re-run CI, the last runs were cancelled",
+      reasons: [approved, `${plural(ci.cancelled.length, "check")} cancelled`],
+    };
+  }
+  if (ci.state === "pending" || ci.state === "none") {
+    const running =
+      ci.pending.length > 0
+        ? `${plural(ci.pending.length, "check")} running`
+        : "No check results yet";
+    return {
+      status: "waiting-ci",
+      nextAction: "Wait for CI to finish",
+      reasons: [approved, running],
+    };
+  }
+  return {
+    status: "ready-to-merge",
+    nextAction: mergeAction(facts, botWaiting),
+    reasons: [
+      approved,
+      ...onlyIf(facts.mergeable === "UNKNOWN", "Mergeability not computed yet"),
+      "CI green",
+    ],
+  };
+}
+
+function mergeAction({ trunk }: TriageFacts, botWaiting: number): string {
+  const merge = trunk.managed ? "Comment /trunk merge" : "Merge it";
+  return botWaiting > 0 ? `Judge the bot findings, then ${merge.toLowerCase()}` : merge;
+}
+
+function reviewStep({ ci }: TriageFacts): StatusStep {
+  const nextAction =
+    ci.state === "awaiting-authorization"
+      ? "Ask for review and CI authorization"
+      : ci.state === "cancelled"
+        ? "Re-run CI, then ask for review"
+        : "Ask for review";
+  return {
+    status: "ready-for-review",
+    nextAction,
+    reasons: [
+      "No current approval",
+      ...onlyIf(ci.state === "awaiting-authorization", "CI also needs authorization"),
+      ...onlyIf(ci.state === "pending", "CI running"),
+      ...onlyIf(ci.state === "cancelled", "CI runs were cancelled"),
+    ],
+  };
+}
+
+function turnOf(reading: PullRequestReading, { status, nextAction: keep }: StatusStep): Turn {
+  const { facts, humanWaiting, hardBlockers } = reading;
+  switch (status) {
+    case "draft":
+      return {
+        group: "drafts",
+        nextAction: humanWaiting.length > 0 ? answerThreads(humanWaiting) : keep,
+      };
+    case "blocked":
+      return { group: "needs-you", nextAction: keep };
+    case "changes-requested":
+      if (awaitsReReview(reading)) {
+        return {
+          group: "waiting-on-others",
+          nextAction: reReview(facts.changeRequesters.map(({ login }) => login)),
+        };
+      }
+      return {
+        group: "needs-you",
+        nextAction:
+          hardBlockers.length === 0 && humanWaiting.length > 0 ? answerThreads(humanWaiting) : keep,
+      };
+    case "ready-to-merge":
+      return { group: "ready-to-merge", nextAction: keep };
+    case "waiting-ci-authorization":
+      return { group: "waiting-on-others", nextAction: keep };
+    case "waiting-ci":
+      return {
+        group: facts.ci.state === "cancelled" ? "needs-you" : "waiting-on-others",
+        nextAction: keep,
+      };
+    case "ready-for-review":
+      if (awaitsRequestedReviewers(facts)) {
+        return { group: "waiting-on-others", nextAction: waitingOn(facts.requestedReviewers) };
+      }
+      return { group: "needs-you", nextAction: keep };
+  }
+}
+
+function awaitsReReview({ facts, humanWaiting, hardBlockers }: PullRequestReading): boolean {
+  return (
+    hardBlockers.length === 0 &&
+    humanWaiting.length === 0 &&
+    facts.review === "changes-requested" &&
+    facts.changeRequesters.length > 0 &&
+    facts.changeRequesters.every(({ login }) => facts.requestedReviewers.includes(login))
+  );
+}
+
+function awaitsRequestedReviewers({ requestedReviewers, ci }: TriageFacts): boolean {
+  return (
+    requestedReviewers.length > 0 &&
+    ci.state !== "awaiting-authorization" &&
+    ci.state !== "cancelled"
+  );
+}
+
+function answerThreads(threads: ReadonlyArray<TriageThreadFacts>): string {
+  const newest = threads.reduce((latest, thread) =>
+    thread.lastAt > latest.lastAt ? thread : latest,
+  );
+  const otherAuthors = new Set(threads.map((thread) => thread.lastAuthor)).size - 1;
+  return `Answer ${plural(threads.length, "thread")} from ${newest.lastAuthor}${andMore(otherAuthors)}`;
+}
+
+function reReview(names: ReadonlyArray<string>): string {
+  const [first, second] = names;
+  const who =
+    names.length === 2 ? `${first} and ${second}` : `${first}${andMore(names.length - 1)}`;
+  return `${who} to re-review`;
+}
+
+function waitingOn([first, ...rest]: ReadonlyArray<string>): string {
+  return `Waiting on ${first}${andMore(rest.length)}`;
+}
+
+function blockersOf(
+  { facts, hardBlockers, threadBlockers }: PullRequestReading,
+  status: TriageStatus,
+): ReadonlyArray<string> {
+  const changeRequest = status === "changes-requested" && facts.review === "changes-requested";
+  return [...onlyIf(changeRequest, changesRequestedBy(facts)), ...hardBlockers, ...threadBlockers];
+}
+
+function openQuestionsOf({
+  facts,
+  humanWaiting,
+  botWaiting,
+}: PullRequestReading): ReadonlyArray<string> {
+  return [
+    ...onlyIf(
+      humanWaiting.length > 0 || facts.humanComments.length > 0,
+      "Do the unanswered human threads or comments ask for changes?",
+    ),
+    ...onlyIf(
+      botWaiting > 0,
+      `Judge ${plural(botWaiting, "unanswered bot finding")}: real defect or noise?`,
+    ),
+    ...onlyIf(facts.isDraft, "Does the description read as a finished change?"),
+  ];
+}
+
+function signalsOf(facts: TriageFacts, now: number): ReadonlyArray<string> {
+  const awaiting = openThreads(facts).filter((thread) => thread.awaitingAuthor);
+  const human = awaiting.filter((thread) => !thread.authorIsBot).length;
+  const bot = awaiting.length - human;
+  const daysSincePush = Math.floor((now - Date.parse(facts.lastPushAt)) / DAY_MS);
+  const stale = daysSincePush >= STALE_DAYS;
+  return [
+    ...onlyIf(stale, `Stale: last push ${daysSincePush} days ago. Modernize candidate`),
+    ...onlyIf(!stale && facts.mergeable === "CONFLICTING", `Conflicts with ${facts.baseRef}`),
+    ...onlyIf(human > 0, `${plural(human, "human thread")} awaiting the author's reply`),
+    ...onlyIf(bot > 0, `${plural(bot, "bot thread")} awaiting the author's reply`),
+    ...onlyIf(facts.trunk.message !== null, `Trunk: ${facts.trunk.message}`),
+  ];
+}
+
+function refinementOf(facts: TriageFacts, viewer: string): TriageRefinement {
+  if (facts.review === "approved") return "approved";
+  const reviewers = [
+    ...facts.approvers,
+    ...facts.changeRequesters,
+    ...facts.threads.map(threadAuthor),
+  ];
+  if (reviewers.some(({ login, isBot }) => !isBot && login !== viewer)) return "human-reviewed";
+  if (reviewers.some(({ isBot }) => isBot)) return "self-reviewed";
+  return "raw";
+}
+
+function countsOf(facts: TriageFacts): TriageClassification["counts"] {
+  const botThreads = facts.threads.filter((thread) => thread.authorIsBot);
+  return {
+    humanThreadsAwaiting: openThreads(facts).filter(
+      (thread) => !thread.authorIsBot && thread.awaitingAuthor,
+    ).length,
+    botFindingsOpen: botThreads.filter((thread) => !thread.isResolved).length,
+    botFindingsResolved: botThreads.filter((thread) => thread.isResolved).length,
+    threadsTruncated: facts.threadsTruncated,
+  };
+}
+
+function openThreads({ threads }: TriageFacts): ReadonlyArray<TriageThreadFacts> {
+  return threads.filter((thread) => !thread.isResolved);
+}
+
+function threadAuthor({ author, authorIsBot }: TriageThreadFacts): TriageReviewer {
+  return { login: author, isBot: authorIsBot };
+}
+
+function changesRequestedBy({ changeRequesters }: TriageFacts): string {
+  return `Changes requested by ${logins(changeRequesters) || "a reviewer"}`;
+}
+
+function logins(reviewers: ReadonlyArray<TriageReviewer>): string {
+  return reviewers.map(({ login }) => login).join(", ");
+}
+
+function andMore(count: number): string {
+  return count > 0 ? ` and ${count} more` : "";
+}
+
+function plural(count: number, word: string): string {
+  return `${count} ${word}${count === 1 ? "" : "s"}`;
+}
+
+function onlyIf(condition: boolean, item: string): ReadonlyArray<string> {
+  return condition ? [item] : [];
+}
diff --git a/apps/server/src/fork/triage/facts.types.ts b/apps/server/src/fork/triage/facts.types.ts
new file mode 100644
index 000000000..ec8ac315d
--- /dev/null
+++ b/apps/server/src/fork/triage/facts.types.ts
@@ -0,0 +1,69 @@
+import type {
+  ThreadPullRequestKey,
+  TriageCiState,
+  TriageMergeable,
+  TriageReviewState,
+} from "@t3tools/contracts";
+
+export interface TriageReviewer {
+  readonly login: string;
+  readonly isBot: boolean;
+}
+
+export interface TriageThreadFacts {
+  readonly isResolved: boolean;
+  readonly isOutdated: boolean;
+  readonly path: string | null;
+  readonly author: string;
+  readonly authorIsBot: boolean;
+  readonly lastAuthor: string;
+  readonly lastAt: string;
+  readonly awaitingAuthor: boolean;
+}
+
+export interface TriageCommentFacts {
+  readonly author: string;
+  readonly body: string;
+  readonly createdAt: string;
+}
+
+export interface TriageCiFacts {
+  readonly state: TriageCiState;
+  readonly failing: ReadonlyArray<string>;
+  readonly cancelled: ReadonlyArray<string>;
+  readonly pending: ReadonlyArray<string>;
+  readonly awaitingAuthorization: number;
+  readonly passed: number;
+}
+
+export interface TriageTrunkFacts {
+  readonly managed: boolean;
+  readonly failed: boolean;
+  readonly message: string | null;
+}
+
+export interface TriageFacts {
+  readonly key: ThreadPullRequestKey;
+  readonly url: string;
+  readonly title: string;
+  readonly isDraft: boolean;
+  readonly headSha: string;
+  readonly baseRef: string;
+  readonly headRef: string;
+  readonly createdAt: string;
+  readonly updatedAt: string;
+  readonly lastPushAt: string;
+  readonly additions: number;
+  readonly deletions: number;
+  readonly changedFiles: number;
+  readonly review: TriageReviewState;
+  readonly approvers: ReadonlyArray<TriageReviewer>;
+  readonly changeRequesters: ReadonlyArray<TriageReviewer>;
+  readonly requestedReviewers: ReadonlyArray<string>;
+  readonly mergeable: TriageMergeable;
+  readonly ci: TriageCiFacts;
+  readonly trunk: TriageTrunkFacts;
+  readonly threads: ReadonlyArray<TriageThreadFacts>;
+  readonly threadsTruncated: boolean;
+  readonly humanComments: ReadonlyArray<TriageCommentFacts>;
+}
diff --git a/packages/contracts/src/forkTriage.ts b/packages/contracts/src/forkTriage.ts
new file mode 100644
index 000000000..f2a513ac8
--- /dev/null
+++ b/packages/contracts/src/forkTriage.ts
@@ -0,0 +1,131 @@
+import * as Schema from "effect/Schema";
+
+import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
+import { ThreadPullRequestKey } from "./orchestration.ts";
+
+export const TRIAGE_STATUSES = [
+  "blocked",
+  "changes-requested",
+  "ready-to-merge",
+  "waiting-ci-authorization",
+  "waiting-ci",
+  "ready-for-review",
+  "draft",
+] as const;
+export const TriageStatus = Schema.Literals(TRIAGE_STATUSES);
+export type TriageStatus = typeof TriageStatus.Type;
+
+export const TRIAGE_GROUPS = [
+  "needs-you",
+  "ready-to-merge",
+  "waiting-on-others",
+  "drafts",
+] as const;
+export const TriageGroup = Schema.Literals(TRIAGE_GROUPS);
+export type TriageGroup = typeof TriageGroup.Type;
+
+export const TriageRefinement = Schema.Literals([
+  "raw",
+  "self-reviewed",
+  "human-reviewed",
+  "approved",
+]);
+export type TriageRefinement = typeof TriageRefinement.Type;
+
+export const TriageCiState = Schema.Literals([
+  "green",
+  "pending",
+  "awaiting-authorization",
+  "cancelled",
+  "failing",
+  "none",
+]);
+export type TriageCiState = typeof TriageCiState.Type;
+
+export const TriageReviewState = Schema.Literals([
+  "approved",
+  "changes-requested",
+  "review-required",
+  "none",
+]);
+export type TriageReviewState = typeof TriageReviewState.Type;
+
+export const TriageMergeable = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
+export type TriageMergeable = typeof TriageMergeable.Type;
+
+export const TriageRisk = Schema.Literals(["low", "medium", "high"]);
+export type TriageRisk = typeof TriageRisk.Type;
+
+export const TriageJudgementBasis = Schema.Literals(["full diff", "diff excerpt", "file list"]);
+export type TriageJudgementBasis = typeof TriageJudgementBasis.Type;
+
+export const TriageJudgement = Schema.Struct({
+  risk: TriageRisk,
+  riskReason: TrimmedNonEmptyString,
+  summary: TrimmedNonEmptyString,
+  basis: TriageJudgementBasis,
+  headSha: TrimmedNonEmptyString,
+  judgedAt: IsoDateTime,
+});
+export type TriageJudgement = typeof TriageJudgement.Type;
+
+export const TriageJudgementState = Schema.Union([
+  Schema.TaggedStruct("ready", { judgement: TriageJudgement }),
+  Schema.TaggedStruct("pending", {}),
+  Schema.TaggedStruct("not-requested", {}),
+  Schema.TaggedStruct("unavailable", { reason: Schema.String }),
+  Schema.TaggedStruct("failed", { reason: Schema.String }),
+]);
+export type TriageJudgementState = typeof TriageJudgementState.Type;
+
+export const TriageCounts = Schema.Struct({
+  humanThreadsAwaiting: NonNegativeInt,
+  botFindingsOpen: NonNegativeInt,
+  botFindingsResolved: NonNegativeInt,
+  threadsTruncated: Schema.Boolean,
+});
+export type TriageCounts = typeof TriageCounts.Type;
+
+export const TriagePullRequest = Schema.Struct({
+  key: ThreadPullRequestKey,
+  url: TrimmedNonEmptyString,
+  title: TrimmedNonEmptyString,
+  isDraft: Schema.Boolean,
+  headSha: TrimmedNonEmptyString,
+  baseRef: Schema.String,
+  headRef: Schema.String,
+  updatedAt: IsoDateTime,
+  lastPushAt: IsoDateTime,
+  additions: NonNegativeInt,
+  deletions: NonNegativeInt,
+  changedFiles: NonNegativeInt,
+  review: TriageReviewState,
+  ci: Schema.Struct({ state: TriageCiState, failing: Schema.Array(Schema.String) }),
+  mergeable: TriageMergeable,
+  requestedReviewers: Schema.Array(Schema.String),
+  status: TriageStatus,
+  group: TriageGroup,
+  nextAction: TrimmedNonEmptyString,
+  blockers: Schema.Array(Schema.String),
+  reasons: Schema.Array(Schema.String),
+  signals: Schema.Array(Schema.String),
+  openQuestions: Schema.Array(Schema.String),
+  refinement: TriageRefinement,
+  counts: TriageCounts,
+  judgement: TriageJudgementState,
+});
+export type TriagePullRequest = typeof TriagePullRequest.Type;
+
+export const TriageReport = Schema.Struct({
+  viewer: Schema.String,
+  fetchedAt: Schema.NullOr(IsoDateTime),
+  error: Schema.NullOr(Schema.String),
+  pullRequests: Schema.Array(TriagePullRequest),
+});
+export type TriageReport = typeof TriageReport.Type;
+
+export const TriageReportInput = Schema.Struct({ refresh: Schema.Boolean });
+export type TriageReportInput = typeof TriageReportInput.Type;
+
+export const TriageAssessInput = ThreadPullRequestKey;
+export type TriageAssessInput = typeof TriageAssessInput.Type;
diff --git a/packages/contracts/src/index.ts b/packages/contracts/src/index.ts
index 978a0459e..8b40dfa87 100644
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -44,3 +44,4 @@ export * from "./resourceTelemetry.ts";
 export * from "./usage.ts";
 export * from "./rpc.ts";
 export * from "./worktreeSetup.ts";
+export * from "./forkTriage.ts";
```

