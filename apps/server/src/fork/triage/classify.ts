/*
 * Status rules ported from the audit-prs skill's classify.ts. The group overlay and its
 * wording are adapted from Postpile (https://github.com/PostHog/postpile at 67a2b82,
 * packages/core/src/whose-turn.ts and changes-answered.ts), under this notice:
 *
 * MIT License
 *
 * Copyright (c) 2026 PostHog Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type {
  TriagePendingAction,
  TriageCounts,
  TriageGroup,
  TriagePullRequest,
  TriageRefinement,
  TriageStatus,
} from "@t3tools/contracts";

import type { TriageFacts, TriageReviewer, TriageThreadFacts } from "./facts.types.ts";

export type TriageClassification = Pick<
  TriagePullRequest,
  | "status"
  | "group"
  | "nextAction"
  | "blockers"
  | "reasons"
  | "signals"
  | "openQuestions"
  | "refinement"
  | "pendingActions"
  | "waiting"
  | "refinementEvidence"
  | "counts"
>;

const STALE_DAYS = 14;
const DAY_MS = 86_400_000;

interface PullRequestReading {
  readonly facts: TriageFacts;
  readonly humanWaiting: ReadonlyArray<TriageThreadFacts>;
  readonly botWaiting: number;
  readonly hardBlockers: ReadonlyArray<string>;
  readonly threadBlockers: ReadonlyArray<string>;
}

interface StatusStep {
  readonly status: TriageStatus;
  readonly nextAction: string;
  readonly reasons: ReadonlyArray<string>;
}

interface Turn {
  readonly group: TriageGroup;
  readonly nextAction: string;
}

export function classifyTriage(
  facts: TriageFacts,
  viewer: string,
  now: number,
): TriageClassification {
  const reading = readPullRequest(facts);
  const step = statusStep(reading);
  return {
    status: step.status,
    ...turnOf(reading, step),
    blockers: blockersOf(reading, step.status),
    reasons: step.reasons,
    signals: signalsOf(facts, now),
    openQuestions: openQuestionsOf(reading),
    refinement: refinementOf(facts, viewer),
    ...pendingWork(reading),
    refinementEvidence: refinementEvidenceOf(facts, viewer),
    counts: countsOf(facts),
  };
}

function readPullRequest(facts: TriageFacts): PullRequestReading {
  const waiting = openThreads(facts).filter(
    (thread) => thread.awaitingAuthor && !thread.isOutdated,
  );
  const humanWaiting = waiting.filter((thread) => !thread.authorIsBot);
  return {
    facts,
    humanWaiting,
    botWaiting: waiting.length - humanWaiting.length,
    hardBlockers: hardBlockersOf(facts),
    threadBlockers: onlyIf(
      humanWaiting.length > 0,
      `Address ${plural(humanWaiting.length, "unresolved reviewer thread")}`,
    ),
  };
}

function hardBlockersOf({ mergeable, ci, trunk }: TriageFacts): ReadonlyArray<string> {
  return [
    ...onlyIf(mergeable === "CONFLICTING", "Resolve merge conflicts"),
    ...onlyIf(ci.state === "failing", `Fix failing CI: ${ci.failing.slice(0, 3).join(", ")}`),
    ...onlyIf(trunk.failed, "Trunk removed the PR from the merge queue"),
  ];
}

function statusStep(reading: PullRequestReading): StatusStep {
  const { facts, hardBlockers, threadBlockers } = reading;
  const [hardBlocker] = hardBlockers;
  const [threadBlocker] = threadBlockers;
  if (facts.isDraft) {
    return {
      status: "draft",
      nextAction: "Finish the implementation",
      reasons: ["Implementation still in progress"],
    };
  }
  if (facts.review === "changes-requested") {
    return {
      status: "changes-requested",
      nextAction: hardBlocker ?? "Address the review feedback",
      reasons: [changesRequestedBy(facts), ...hardBlockers, ...threadBlockers],
    };
  }
  if (hardBlocker) {
    return {
      status: "blocked",
      nextAction: hardBlocker,
      reasons: [...hardBlockers, ...threadBlockers],
    };
  }
  if (threadBlocker) {
    return {
      status: "changes-requested",
      nextAction: threadBlocker,
      reasons: ["A reviewer asked for changes in a thread", ...threadBlockers],
    };
  }
  if (facts.mergeQueued)
    return {
      status: "waiting-merge",
      nextAction: "Wait in the merge queue",
      reasons: ["PR is in the merge queue"],
    };
  if (facts.review === "approved") return approvedStep(reading);
  return reviewStep(facts);
}

function approvedStep({ facts, botWaiting }: PullRequestReading): StatusStep {
  const { ci } = facts;
  const approved = `Approved by ${logins(facts.approvers) || "a reviewer"}`;
  if (ci.state === "awaiting-authorization") {
    return {
      status: "waiting-ci-authorization",
      nextAction: "Ask a maintainer to authorize the CI run",
      reasons: [approved, `${plural(ci.awaitingAuthorization, "workflow")} need authorization`],
    };
  }
  if (ci.state === "cancelled") {
    return {
      status: "waiting-ci",
      nextAction: "Re-run CI, the last runs were cancelled",
      reasons: [approved, `${plural(ci.cancelled.length, "check")} cancelled`],
    };
  }
  if (ci.state === "pending" || ci.state === "none") {
    const running =
      ci.pending.length > 0
        ? `${plural(ci.pending.length, "check")} running`
        : "No check results yet";
    return {
      status: "waiting-ci",
      nextAction: "Wait for CI to finish",
      reasons: [approved, running],
    };
  }
  return {
    status: "ready-to-merge",
    nextAction: mergeAction(facts, botWaiting),
    reasons: [
      approved,
      ...onlyIf(facts.mergeable === "UNKNOWN", "Mergeability not computed yet"),
      "CI green",
    ],
  };
}

function mergeAction({ trunk }: TriageFacts, botWaiting: number): string {
  const merge = trunk.managed ? "Comment /trunk merge" : "Merge it";
  return botWaiting > 0 ? `Judge the bot findings, then ${merge.toLowerCase()}` : merge;
}

function reviewStep({ ci }: TriageFacts): StatusStep {
  const nextAction =
    ci.state === "awaiting-authorization"
      ? "Ask for review and CI authorization"
      : ci.state === "cancelled"
        ? "Re-run CI, then ask for review"
        : "Ask for review";
  return {
    status: "ready-for-review",
    nextAction,
    reasons: [
      "No current approval",
      ...onlyIf(ci.state === "awaiting-authorization", "CI also needs authorization"),
      ...onlyIf(ci.state === "pending", "CI running"),
      ...onlyIf(ci.state === "cancelled", "CI runs were cancelled"),
    ],
  };
}

function turnOf(reading: PullRequestReading, { status, nextAction: keep }: StatusStep): Turn {
  const { facts, humanWaiting, hardBlockers } = reading;
  switch (status) {
    case "draft":
      return {
        group: "drafts",
        nextAction: humanWaiting.length > 0 ? answerThreads(humanWaiting) : keep,
      };
    case "blocked":
      return { group: "needs-you", nextAction: keep };
    case "changes-requested":
      if (awaitsReReview(reading)) {
        return {
          group: "waiting-on-others",
          nextAction: reReview(facts.changeRequesters.map(({ login }) => login)),
        };
      }
      return {
        group: "needs-you",
        nextAction:
          hardBlockers.length === 0 && humanWaiting.length > 0 ? answerThreads(humanWaiting) : keep,
      };
    case "ready-to-merge":
      return { group: "ready-to-merge", nextAction: keep };
    case "waiting-merge":
      return { group: "waiting-on-others", nextAction: keep };
    case "waiting-ci-authorization":
      return { group: "waiting-on-others", nextAction: keep };
    case "waiting-ci":
      return {
        group: facts.ci.state === "cancelled" ? "needs-you" : "waiting-on-others",
        nextAction: keep,
      };
    case "ready-for-review":
      if (awaitsRequestedReviewers(facts)) {
        return { group: "waiting-on-others", nextAction: waitingOn(facts.requestedReviewers) };
      }
      return { group: "needs-you", nextAction: keep };
  }
}

function awaitsReReview({ facts, humanWaiting, hardBlockers }: PullRequestReading): boolean {
  return (
    hardBlockers.length === 0 &&
    humanWaiting.length === 0 &&
    facts.review === "changes-requested" &&
    facts.changeRequesters.length > 0 &&
    facts.changeRequesters.every(({ login }) => facts.requestedReviewers.includes(login))
  );
}

function awaitsRequestedReviewers({ requestedReviewers, ci }: TriageFacts): boolean {
  return (
    requestedReviewers.length > 0 &&
    ci.state !== "awaiting-authorization" &&
    ci.state !== "cancelled"
  );
}

function answerThreads(threads: ReadonlyArray<TriageThreadFacts>): string {
  const newest = threads.reduce((latest, thread) =>
    thread.lastAt > latest.lastAt ? thread : latest,
  );
  const otherAuthors = new Set(threads.map(humanToAnswer)).size - 1;
  return `Answer ${plural(threads.length, "thread")} from ${humanToAnswer(newest)}${andMore(otherAuthors)}`;
}

function humanToAnswer({ author, lastAuthor, lastAuthorIsBot }: TriageThreadFacts): string {
  return lastAuthorIsBot ? author : lastAuthor;
}

function reReview(names: ReadonlyArray<string>): string {
  const [first, second] = names;
  const who =
    names.length === 2 ? `${first} and ${second}` : `${first}${andMore(names.length - 1)}`;
  return `${who} to re-review`;
}

function waitingOn([first, ...rest]: ReadonlyArray<string>): string {
  return `Waiting on ${first}${andMore(rest.length)}`;
}

function blockersOf(
  { facts, hardBlockers, threadBlockers }: PullRequestReading,
  status: TriageStatus,
): ReadonlyArray<string> {
  const changeRequest = status === "changes-requested" && facts.review === "changes-requested";
  return [...onlyIf(changeRequest, changesRequestedBy(facts)), ...hardBlockers, ...threadBlockers];
}

function openQuestionsOf({
  facts,
  humanWaiting,
  botWaiting,
}: PullRequestReading): ReadonlyArray<string> {
  return [
    ...onlyIf(
      humanWaiting.length > 0 || facts.humanComments.length > 0,
      "Do the unanswered human threads or comments ask for changes?",
    ),
    ...onlyIf(
      botWaiting > 0,
      `Judge ${plural(botWaiting, "unanswered bot finding")}: real defect or noise?`,
    ),
    ...onlyIf(facts.isDraft, "Does the description read as a finished change?"),
  ];
}

function signalsOf(facts: TriageFacts, now: number): ReadonlyArray<string> {
  const awaiting = openThreads(facts).filter((thread) => thread.awaitingAuthor);
  const human = awaiting.filter((thread) => !thread.authorIsBot).length;
  const bot = awaiting.length - human;
  const daysSincePush = Math.floor((now - Date.parse(facts.lastPushAt)) / DAY_MS);
  const stale = daysSincePush >= STALE_DAYS;
  return [
    ...onlyIf(stale, `Stale: last push ${daysSincePush} days ago. Modernize candidate`),
    ...onlyIf(!stale && facts.mergeable === "CONFLICTING", `Conflicts with ${facts.baseRef}`),
    ...onlyIf(human > 0, `${plural(human, "human thread")} awaiting the author's reply`),
    ...onlyIf(bot > 0, `${plural(bot, "bot thread")} awaiting the author's reply`),
    ...onlyIf(facts.trunk.message !== null, `Trunk: ${facts.trunk.message}`),
  ];
}

function refinementOf(facts: TriageFacts, viewer: string): TriageRefinement {
  if (facts.review === "approved") return "approved";
  const reviewers = [
    ...facts.approvers,
    ...facts.changeRequesters,
    ...facts.threads.map(threadAuthor),
  ];
  if (reviewers.some(({ login, isBot }) => !isBot && login !== viewer)) return "human-reviewed";
  if (reviewers.some(({ isBot }) => isBot)) return "self-reviewed";
  return "raw";
}

function countsOf(facts: TriageFacts): TriageCounts {
  const botThreads = facts.threads.filter((thread) => thread.authorIsBot);
  return {
    humanThreadsAwaiting: openThreads(facts).filter(
      (thread) => !thread.authorIsBot && thread.awaitingAuthor,
    ).length,
    botFindingsOpen: botThreads.filter((thread) => !thread.isResolved).length,
    botFindingsResolved: botThreads.filter((thread) => thread.isResolved).length,
    threadsTruncated: facts.threadsTruncated,
  };
}

function openThreads({ threads }: TriageFacts): ReadonlyArray<TriageThreadFacts> {
  return threads.filter((thread) => !thread.isResolved);
}

function threadAuthor({ author, authorIsBot }: TriageThreadFacts): TriageReviewer {
  return { login: author, isBot: authorIsBot };
}

function changesRequestedBy({ changeRequesters }: TriageFacts): string {
  return `Changes requested by ${logins(changeRequesters) || "a reviewer"}`;
}

function logins(reviewers: ReadonlyArray<TriageReviewer>): string {
  return reviewers.map(({ login }) => login).join(", ");
}

function andMore(count: number): string {
  return count > 0 ? ` and ${count} more` : "";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function onlyIf(condition: boolean, item: string): ReadonlyArray<string> {
  return condition ? [item] : [];
}

function pendingWork(reading: PullRequestReading) {
  const { facts, humanWaiting, botWaiting } = reading;
  const pendingActions: TriagePendingAction[] = [];
  const waiting: string[] = [];
  const add = (kind: TriagePendingAction["kind"], label: string) =>
    pendingActions.push({ kind, label });
  if (facts.isDraft) add("finish", "Finish the implementation");
  if (facts.mergeable === "CONFLICTING") add("conflicts", "Resolve merge conflicts");
  if (facts.ci.state === "failing")
    add(
      "fix-ci",
      facts.ci.failing.length ? `Fix failing CI: ${facts.ci.failing.join(", ")}` : "Fix failing CI",
    );
  const reReview = awaitsReReview(reading);
  if (humanWaiting.length > 0 || (facts.review === "changes-requested" && !reReview)) {
    add(
      "feedback",
      humanWaiting.length > 0 ? answerThreads(humanWaiting) : "Address the review feedback",
    );
  }
  if (botWaiting > 0) add("judge-bots", `Judge ${plural(botWaiting, "unanswered bot finding")}`);
  if (facts.ci.state === "cancelled") add("rerun-ci", "Re-run cancelled CI");
  if (facts.ci.state === "pending" || facts.ci.state === "none")
    waiting.push(
      facts.ci.state === "pending" ? "Waiting for CI to finish" : "Waiting for check results",
    );
  if (!facts.isDraft) {
    if (facts.ci.state === "awaiting-authorization") add("authorize-ci", "Authorize the CI run");
    if (reReview) add("review", `Re-review the PR: ${facts.requestedReviewers.join(", ")}`);
    else if (
      facts.review !== "approved" &&
      facts.review !== "changes-requested" &&
      humanWaiting.length === 0
    ) {
      add(
        "review",
        facts.requestedReviewers.length
          ? `Review the PR: ${facts.requestedReviewers.join(", ")}`
          : "Review the PR",
      );
    }
    if (facts.mergeQueued) waiting.push("Waiting in the merge queue");
    else if (
      facts.review === "approved" &&
      facts.ci.state === "green" &&
      facts.mergeable === "MERGEABLE" &&
      reading.hardBlockers.length === 0 &&
      humanWaiting.length === 0 &&
      botWaiting === 0
    ) {
      add("merge", facts.trunk.managed ? "Comment /trunk merge" : "Merge the PR");
    }
    if (facts.mergeable === "UNKNOWN") waiting.push("Waiting for mergeability to be computed");
  }
  return { pendingActions, waiting };
}

function refinementEvidenceOf(facts: TriageFacts, viewer: string): string {
  switch (refinementOf(facts, viewer)) {
    case "approved":
      return `Current approval from ${logins(facts.approvers) || "a reviewer"}`;
    case "human-reviewed":
      return "A human reviewer left a review or review thread";
    case "self-reviewed":
      return "Bot review or review-thread evidence; no QA swarm is inferred";
    case "raw":
      return "No human or bot review evidence yet";
  }
}
