import type { TriagePullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupTriagePullRequests } from "./grouping.logic";

function pullRequest(
  number: number,
  overrides: Partial<Pick<TriagePullRequest, "group" | "status" | "updatedAt">>,
): TriagePullRequest {
  return {
    key: { host: "github.com", repository: "acme/app", number },
    url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`,
    isDraft: false,
    headSha: "abc123",
    baseRef: "main",
    headRef: `branch-${number}`,
    updatedAt: "2026-10-01T10:00:00.000Z",
    lastPushAt: "2026-10-01T10:00:00.000Z",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    review: "none",
    ci: { state: "green", failing: [] },
    mergeable: "MERGEABLE",
    requestedReviewers: [],
    status: "ready-for-review",
    group: "needs-you",
    nextAction: "Ask for review",
    blockers: [],
    reasons: [],
    signals: [],
    openQuestions: [],
    refinement: "raw",
    counts: {
      humanThreadsAwaiting: 0,
      botFindingsOpen: 0,
      botFindingsResolved: 0,
      threadsTruncated: false,
    },
    judgement: { _tag: "unavailable", reason: "Risk judgement is not built yet" },
    ...overrides,
  };
}

function numbersByGroup(prs: ReadonlyArray<TriagePullRequest>) {
  return groupTriagePullRequests(prs).map(({ group, pullRequests }) => [
    group,
    pullRequests.map((pr) => pr.key.number),
  ]);
}

describe("groupTriagePullRequests", () => {
  it("lists groups in the order Needs you, Ready to merge, Waiting on others, Drafts", () => {
    const prs = [
      pullRequest(1, { group: "drafts", status: "draft" }),
      pullRequest(2, { group: "waiting-on-others" }),
      pullRequest(3, { group: "ready-to-merge", status: "ready-to-merge" }),
      pullRequest(4, { group: "needs-you" }),
    ];

    expect(numbersByGroup(prs)).toEqual([
      ["needs-you", [4]],
      ["ready-to-merge", [3]],
      ["waiting-on-others", [2]],
      ["drafts", [1]],
    ]);
  });

  it("hides groups without pull requests", () => {
    const prs = [
      pullRequest(1, { group: "drafts", status: "draft" }),
      pullRequest(2, { group: "needs-you" }),
    ];

    expect(numbersByGroup(prs)).toEqual([
      ["needs-you", [2]],
      ["drafts", [1]],
    ]);
  });

  it("returns no groups when there are no pull requests", () => {
    expect(groupTriagePullRequests([])).toEqual([]);
  });

  it("sorts a group by status urgency, then by the newest update", () => {
    const prs = [
      pullRequest(1, { status: "ready-for-review", updatedAt: "2026-10-03T09:00:00.000Z" }),
      pullRequest(2, { status: "changes-requested", updatedAt: "2026-10-01T09:00:00.000Z" }),
      pullRequest(3, { status: "blocked", updatedAt: "2026-09-20T09:00:00.000Z" }),
      pullRequest(4, { status: "changes-requested", updatedAt: "2026-10-02T09:00:00.000Z" }),
      pullRequest(5, { status: "waiting-ci", updatedAt: "2026-10-03T12:00:00.000Z" }),
    ];

    expect(numbersByGroup(prs)).toEqual([["needs-you", [3, 4, 2, 5, 1]]]);
  });
});
