import { describe, expect, it } from "vite-plus/test";
import { classifySnapshot } from "./classifier.ts";
import type { GitHubItemSnapshot } from "./github.ts";

const snapshot = (overrides: Partial<GitHubItemSnapshot> = {}): GitHubItemSnapshot => ({
  repo: "example/widgets",
  number: 1,
  kind: "pull-request",
  item: { state: "open" },
  pull: {
    state: "open",
    head: { sha: "current" },
    mergeable: true,
    html_url: "https://github.com/example/widgets/pull/1",
  },
  comments: [],
  reviewComments: [],
  reviews: [],
  checks: [],
  timeline: [],
  parent: null,
  children: [],
  blockedBy: [],
  blocking: [],
  truncatedSources: [],
  unavailableSources: [],
  rules: [],
  reviewState: { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", viewerPermission: "WRITE" },
  ...overrides,
});

describe("merge readiness", () => {
  it("marks an unconfirmed discussion dependency on an issue as uncertain", () => {
    const result = classifySnapshot(snapshot({ kind: "issue", pull: null }), undefined, [
      {
        kind: "depends-on",
        target: "example/widgets#2",
        source: "text-candidate",
        evidenceUrl: "https://github.com/example/widgets/issues/1",
        certainty: "uncertain",
      },
    ]);
    expect(result.certainty).toBe("uncertain");
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "discussion-dependency-unknown",
    );
  });
  it("keeps a conflicted PR out of ready for review even when approval is still required", () => {
    const result = classifySnapshot(
      snapshot({
        pull: { state: "open", head: { sha: "current" }, mergeable: false },
        reviewState: {
          reviewDecision: "REVIEW_REQUIRED",
          mergeStateStatus: "DIRTY",
          viewerPermission: "WRITE",
        },
      }),
      undefined,
      [],
    );
    expect(result.classification).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("approval-required");
    expect(result.blockers.map((b) => b.code)).toContain("merge-conflict");
  });
  it("requires the configured GitHub App's check, even when another app has the same green name", () => {
    const result = classifySnapshot(
      snapshot({
        rules: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "tests", integration_id: 42 }] },
          },
        ],
        checks: [{ name: "tests", head_sha: "current", conclusion: "success", app: { id: 7 } }],
      }),
      undefined,
      [],
    );
    expect(result.classification).not.toBe("ready-maintainer");
    expect(result.blockers.some((b) => b.code === "check-missing")).toBe(true);
  });
  it("keeps an unexplained GitHub merge block alongside a required review", () => {
    const result = classifySnapshot(
      snapshot({
        reviewState: {
          reviewDecision: "REVIEW_REQUIRED",
          mergeStateStatus: "BLOCKED",
          viewerPermission: "WRITE",
        },
      }),
      undefined,
      [],
    );
    expect(result.blockers.map((b) => b.code)).toContain("merge-eligibility-unknown");
    expect(result.blockers.map((b) => b.code)).toContain("approval-required");
  });
  it("shows a fully checked PR awaiting enqueue as ready for a maintainer", () => {
    const result = classifySnapshot(
      snapshot(),
      {
        repo: "example/widgets",
        requiredApprovals: 0,
        requiredChecks: [],
        requireMergeable: true,
        externalQueue: "maintainer",
      },
      [],
    );
    expect(result.classification).toBe("ready-maintainer");
    expect(result.nextActors).toEqual(["maintainer"]);
    expect(result.blockers.map((b) => b.code)).toContain("external-queue-required");
  });
  it("keeps a behind branch out of merge readiness", () => {
    const result = classifySnapshot(
      snapshot({
        reviewState: {
          reviewDecision: "APPROVED",
          mergeStateStatus: "BEHIND",
          viewerPermission: "WRITE",
        },
      }),
      undefined,
      [],
    );
    expect(result.blockers.map((b) => b.code)).toContain("rebase-required");
  });
});
