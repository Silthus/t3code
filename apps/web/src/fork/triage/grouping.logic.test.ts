import type { TriagePullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { groupTriagePullRequests, effectiveTriageActions } from "./grouping.logic";

function pr(
  number: number,
  pendingActions: TriagePullRequest["pendingActions"],
  overrides: Partial<TriagePullRequest> = {},
) {
  return {
    key: { host: "GitHub.COM", repository: "Acme/App", number },
    pendingActions,
    status: "ready-for-review",
    updatedAt: "2026-10-05T00:00:00Z",
    ...overrides,
  } as TriagePullRequest;
}
const review = { kind: "review", label: "Review the PR" } as const;
const conflict = { kind: "conflicts", label: "Resolve merge conflicts" } as const;
const groups = (prs: TriagePullRequest[], preferences = { global: {}, repositories: {} }) =>
  groupTriagePullRequests(prs, preferences).map(({ group, pullRequests }) => [
    group,
    pullRequests.map((pr) => pr.key.number),
  ]);

describe("author queues", () => {
  it("puts mixed-owner PRs in my queue without hiding the team action", () => {
    const mixed = pr(1, [conflict, review]);
    expect(groups([pr(2, [review]), mixed, pr(3, [], { waiting: ["Waiting for CI"] })])).toEqual([
      ["needs-my-action", [1]],
      ["needs-team-action", [2, 3]],
    ]);
    expect(effectiveTriageActions(mixed).map(({ owner }) => owner)).toEqual(["author", "team"]);
  });
  it("uses normalized repository overrides and restores the inherited queue on removal", () => {
    const preferences = {
      global: { owners: { review: "team" as const } },
      repositories: { "github.com/acme/app": { owners: { review: "author" as const } } },
    };
    expect(groupTriagePullRequests([pr(1, [review])], preferences)[0]?.group).toBe(
      "needs-my-action",
    );
    expect(
      groupTriagePullRequests([pr(1, [review])], { ...preferences, repositories: {} })[0]?.group,
    ).toBe("needs-team-action");
  });
  it("sorts by urgency, latest update and a stable PR identity", () => {
    expect(
      groups([
        pr(2, [conflict]),
        pr(1, [conflict]),
        pr(3, [conflict], { status: "blocked" }),
        pr(4, [conflict], { updatedAt: "2026-10-06T00:00:00Z" }),
      ]),
    ).toEqual([["needs-my-action", [3, 4, 1, 2]]]);
    expect(groupTriagePullRequests([])).toEqual([]);
  });
});
