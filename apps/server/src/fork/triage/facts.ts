/*
 * Ported from the audit-prs skill's facts.ts (`isBot`, `KNOWN_BOTS`, `ciFacts`, `trunkFacts`,
 * thread and comment facts), adapted to the triage search node.
 */
import type { TriageCiState, TriageMergeable, TriageReviewState } from "@t3tools/contracts";

import type {
  TriageCiFacts,
  TriageCommentFacts,
  TriageFacts,
  TriageReviewer,
  TriageThreadFacts,
  TriageTrunkFacts,
} from "./facts.types.ts";
import { TRIAGE_HOST, type TriageActor, type TriagePullRequestNode } from "./TriageGitHub.ts";

const KNOWN_BOTS = new Set([
  "coderabbitai",
  "trunk-io",
  "github-actions",
  "dependabot",
  "renovate",
  "vercel",
  "greptile-apps",
  "posthog-bot",
  "codecov",
]);
const LISTED_CHECKS = 50;
const LISTED_THREADS = 50;
const HIDDEN_REVIEWER = "a reviewer";
const MERGEABLE_STATES: ReadonlySet<string> = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);

type Commit = NonNullable<TriagePullRequestNode["commits"]["nodes"][number]>["commit"];

function isBot(actor: TriageActor): boolean {
  if (!actor) return true;
  return actor.__typename === "Bot" || actor.login.endsWith("[bot]") || KNOWN_BOTS.has(actor.login);
}

export function toFacts(node: TriagePullRequestNode, viewer: string): TriageFacts {
  const head = node.commits.nodes[0]?.commit;
  const reviews = node.latestOpinionatedReviews.nodes;
  return {
    key: { host: TRIAGE_HOST, repository: node.repository.nameWithOwner, number: node.number },
    url: node.url,
    title: node.title,
    isDraft: node.isDraft,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    headRef: node.headRefName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    lastPushAt: head?.committedDate ?? node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    review: reviewState(node.reviewDecision),
    approvers: reviews.filter((review) => review.state === "APPROVED").map(reviewerOf),
    changeRequesters: reviews
      .filter((review) => review.state === "CHANGES_REQUESTED")
      .map(reviewerOf),
    requestedReviewers: requestedReviewersOf(node),
    mergeable: MERGEABLE_STATES.has(node.mergeable)
      ? (node.mergeable as TriageMergeable)
      : "UNKNOWN",
    ci: withUnlistedFailure(ciFacts(head), head),
    trunk: trunkFacts(node),
    threads: node.reviewThreads.nodes.map((thread) => threadFacts(thread, viewer)),
    threadsTruncated: node.reviewThreads.totalCount > LISTED_THREADS,
    humanComments: humanCommentsOf(node, viewer),
  };
}

function reviewState(decision: string | null): TriageReviewState {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return "none";
  }
}

function reviewerOf(review: { readonly author: TriageActor }): TriageReviewer {
  return { login: review.author?.login ?? "?", isBot: isBot(review.author) };
}

/** Users before teams. A team hidden from this login arrives as `null` and still counts. */
function requestedReviewersOf(node: TriagePullRequestNode): ReadonlyArray<string> {
  const requested = node.reviewRequests.nodes.map((request) => request.requestedReviewer);
  const users = requested.flatMap((reviewer) => (reviewer?.login ? [reviewer.login] : []));
  const teams = requested.flatMap((reviewer) =>
    reviewer?.login ? [] : [reviewer?.name ?? HIDDEN_REVIEWER],
  );
  return [...users, ...teams];
}

function ciFacts(commit: Commit | undefined): TriageCiFacts {
  const checks = commit?.statusCheckRollup?.contexts.nodes ?? [];
  const suites = commit?.checkSuites.nodes ?? [];
  const failing: string[] = [];
  const cancelled: string[] = [];
  const pending: string[] = [];
  let passed = 0;
  for (const check of checks) {
    if (check.__typename === "CheckRun") {
      const name = check.name ?? "check";
      if (check.status !== "COMPLETED") pending.push(name);
      else if (["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"].includes(check.conclusion ?? ""))
        failing.push(name);
      else if (check.conclusion === "CANCELLED") cancelled.push(name);
      else passed++;
    } else {
      const name = check.context ?? "status";
      if (check.state === "PENDING" || check.state === "EXPECTED") pending.push(name);
      else if (check.state === "FAILURE" || check.state === "ERROR") failing.push(name);
      else passed++;
    }
  }
  const awaitingAuthorization = suites.filter(
    (suite) => suite.conclusion === "ACTION_REQUIRED",
  ).length;
  const suitesRunning = suites.some((suite) => suite.status !== "COMPLETED");
  let state: TriageCiState = "none";
  if (failing.length) state = "failing";
  else if (awaitingAuthorization) state = "awaiting-authorization";
  else if (pending.length || suitesRunning) state = "pending";
  else if (cancelled.length) state = "cancelled";
  else if (passed) state = "green";
  return { state, failing, cancelled, pending, awaitingAuthorization, passed };
}

/**
 * The search lists the first 50 checks only. When the rollup failed, more checks exist than were
 * listed, and none of the listed ones failed, the failing one sits past the list.
 */
function withUnlistedFailure(ci: TriageCiFacts, commit: Commit | undefined): TriageCiFacts {
  const rollup = commit?.statusCheckRollup;
  const rollupFailed = rollup?.state === "FAILURE" || rollup?.state === "ERROR";
  const listIsPartial = (rollup?.contexts.totalCount ?? 0) > (rollup?.contexts.nodes.length ?? 0);
  if (!rollupFailed || !listIsPartial || ci.failing.length > 0) return ci;
  return {
    ...ci,
    state: "failing",
    failing: [`a check past the first ${LISTED_CHECKS}`],
  };
}

function trunkFacts(node: TriagePullRequestNode): TriageTrunkFacts {
  const comment = node.comments.nodes.findLast(
    (candidate) => candidate.author?.login === "trunk-io" && candidate.body.includes("Trunk"),
  );
  if (!comment) return { managed: false, failed: false, message: null };
  const firstLine =
    comment.body
      .replace(/<!--.*?-->/gs, "")
      .trim()
      .split("\n")[0] ?? "";
  const failed = /🚫|❌|removed from the merge queue|failed/i.test(firstLine);
  return { managed: true, failed, message: failed ? firstLine.slice(0, 300) : null };
}

function threadFacts(
  thread: TriagePullRequestNode["reviewThreads"]["nodes"][number],
  viewer: string,
): TriageThreadFacts {
  const first = thread.first.nodes[0];
  const last = thread.last.nodes[0];
  const lastAuthor = last?.author?.login ?? "unknown";
  return {
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    author: first?.author?.login ?? "unknown",
    authorIsBot: isBot(first?.author ?? null),
    lastAuthor,
    lastAuthorIsBot: isBot(last?.author ?? null),
    lastAt: last?.createdAt ?? "",
    awaitingAuthor: lastAuthor !== viewer,
  };
}

function humanCommentsOf(
  node: TriagePullRequestNode,
  viewer: string,
): ReadonlyArray<TriageCommentFacts> {
  return node.comments.nodes
    .flatMap((comment) =>
      comment.author && !isBot(comment.author) && comment.author.login !== viewer
        ? [
            {
              author: comment.author.login,
              body: clip(comment.body, 500),
              createdAt: comment.createdAt,
            },
          ]
        : [],
    )
    .slice(-8);
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
