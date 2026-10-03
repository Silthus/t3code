import { describe, expect, it } from "vite-plus/test";

import { classifyTriage } from "./classify.ts";
import type { TriageFacts, TriageThreadFacts } from "./facts.types.ts";

const VIEWER = "me";
const NOW = Date.parse("2026-09-23T00:00:00Z");

function facts(overrides: Partial<TriageFacts> = {}): TriageFacts {
  return {
    key: { host: "github.com", repository: "o/r", number: 1 },
    url: "https://github.com/o/r/pull/1",
    title: "t",
    isDraft: false,
    headSha: "abc",
    baseRef: "master",
    headRef: "feat",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-22T00:00:00Z",
    lastPushAt: "2026-09-22T00:00:00Z",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    review: "review-required",
    approvers: [],
    changeRequesters: [],
    requestedReviewers: [],
    mergeable: "MERGEABLE",
    ci: {
      state: "green",
      failing: [],
      cancelled: [],
      pending: [],
      awaitingAuthorization: 0,
      passed: 5,
    },
    trunk: { managed: true, failed: false, message: null },
    threads: [],
    threadsTruncated: false,
    humanComments: [],
    ...overrides,
  };
}

const humanThread: TriageThreadFacts = {
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  author: "alice",
  authorIsBot: false,
  lastAuthor: "alice",
  lastAt: "2026-09-22T00:00:00Z",
  awaitingAuthor: true,
};
const botThread: TriageThreadFacts = {
  ...humanThread,
  author: "coderabbitai",
  authorIsBot: true,
  lastAuthor: "coderabbitai",
};
const resolved = (thread: TriageThreadFacts): TriageThreadFacts => ({
  ...thread,
  isResolved: true,
});
const human = (login: string) => ({ login, isBot: false });

const classify = (overrides: Partial<TriageFacts> = {}) =>
  classifyTriage(facts(overrides), VIEWER, NOW);
const ci = (overrides: Partial<TriageFacts["ci"]>) => ({ ...facts().ci, ...overrides });

describe("status (audit-prs classify without Jev)", () => {
  it("counts a human thread that awaits the author's reply as a change request and asks to confirm", () => {
    const result = classify({ threads: [humanThread] });
    expect(result.status).toBe("changes-requested");
    expect(result.openQuestions.join(" ")).toMatch(/ask for changes/);
  });

  it("does not block on a human thread the author answered last", () => {
    const answered = { ...humanThread, lastAuthor: VIEWER, awaitingAuthor: false };
    expect(classify({ threads: [answered] }).status).toBe("ready-for-review");
  });

  it("never blocks on bot findings alone and leaves them to judge", () => {
    const result = classify({ review: "approved", threads: [botThread] });
    expect(result.status).toBe("ready-to-merge");
    expect(result.openQuestions).toEqual(["Judge 1 unanswered bot finding: real defect or noise?"]);
    expect(result.nextAction).toBe("Judge the bot findings, then comment /trunk merge");
  });

  it("never calls a draft finished", () => {
    const result = classify({ isDraft: true });
    expect(result.nextAction).toBe("Finish the implementation");
    expect(result.openQuestions).toContain("Does the description read as a finished change?");
  });

  it("puts conflicts before everything except an explicit changes-requested review", () => {
    expect(classify({ review: "approved", mergeable: "CONFLICTING" }).status).toBe("blocked");
    expect(classify({ review: "changes-requested", mergeable: "CONFLICTING" }).status).toBe(
      "changes-requested",
    );
  });

  it("ranks a hard blocker above an unanswered human thread", () => {
    expect(classify({ mergeable: "CONFLICTING", threads: [humanThread] })).toMatchObject({
      status: "blocked",
      group: "needs-you",
      nextAction: "Resolve merge conflicts",
      blockers: ["Resolve merge conflicts", "Address 1 unresolved reviewer thread"],
      reasons: ["Resolve merge conflicts", "Address 1 unresolved reviewer thread"],
    });
  });

  it("ranks a draft above every other rule", () => {
    const result = classify({
      isDraft: true,
      review: "changes-requested",
      mergeable: "CONFLICTING",
      threads: [humanThread],
    });
    expect(result).toMatchObject({
      status: "draft",
      group: "drafts",
      nextAction: "Answer 1 thread from alice",
      blockers: ["Resolve merge conflicts", "Address 1 unresolved reviewer thread"],
    });
  });

  it("ranks an unanswered human thread above an approval", () => {
    expect(classify({ review: "approved", threads: [humanThread] })).toMatchObject({
      status: "changes-requested",
      group: "needs-you",
      nextAction: "Answer 1 thread from alice",
    });
  });

  it("blocks an approved PR that Trunk removed from the merge queue", () => {
    const trunk = { managed: true, failed: true, message: null };
    expect(classify({ review: "approved", trunk })).toMatchObject({
      status: "blocked",
      group: "needs-you",
      nextAction: "Trunk removed the PR from the merge queue",
      blockers: ["Trunk removed the PR from the merge queue"],
      reasons: ["Trunk removed the PR from the merge queue"],
    });
  });

  it("gives approved PRs whose CI waits for a maintainer their own status", () => {
    const result = classify({
      review: "approved",
      ci: ci({ state: "awaiting-authorization", awaitingAuthorization: 12, passed: 0 }),
    });
    expect(result.status).toBe("waiting-ci-authorization");
  });

  it("ignores resolved threads", () => {
    expect(classify({ threads: [resolved(humanThread)] }).status).toBe("ready-for-review");
  });

  it("lists the change request, hard blockers, and thread blockers as blockers", () => {
    const result = classify({
      review: "changes-requested",
      changeRequesters: [human("ada")],
      ci: ci({ state: "failing", failing: ["lint", "test", "build", "e2e"] }),
      threads: [humanThread],
    });
    expect(result.blockers).toEqual([
      "Changes requested by ada",
      "Fix failing CI: lint, test, build",
      "Address 1 unresolved reviewer thread",
    ]);
  });

  it("has no blockers when nothing blocks", () => {
    expect(classify({ review: "approved" }).blockers).toEqual([]);
  });

  it("does not block on an outdated human thread, but still counts it", () => {
    const result = classify({ threads: [{ ...humanThread, isOutdated: true }] });
    expect(result.status).toBe("ready-for-review");
    expect(result.counts.humanThreadsAwaiting).toBe(1);
  });

  it("asks whether unanswered human comments ask for changes", () => {
    const comment = { author: "ada", body: "Why this way?", createdAt: "2026-09-22T00:00:00Z" };
    expect(classify({ humanComments: [comment] }).openQuestions).toEqual([
      "Do the unanswered human threads or comments ask for changes?",
    ]);
  });

  const approvedBy = (overrides: Partial<TriageFacts>) => ({
    review: "approved" as const,
    approvers: [human("ada")],
    ...overrides,
  });

  it.each([
    ["S1", { isDraft: true }, "draft", ["Implementation still in progress"]],
    [
      "S2",
      { review: "changes-requested" as const, changeRequesters: [human("ada")] },
      "changes-requested",
      ["Changes requested by ada"],
    ],
    ["S3", { mergeable: "CONFLICTING" as const }, "blocked", ["Resolve merge conflicts"]],
    [
      "S4",
      { threads: [humanThread] },
      "changes-requested",
      ["A reviewer asked for changes in a thread", "Address 1 unresolved reviewer thread"],
    ],
    [
      "S5",
      approvedBy({ ci: ci({ state: "awaiting-authorization", awaitingAuthorization: 2 }) }),
      "waiting-ci-authorization",
      ["Approved by ada", "2 workflows need authorization"],
    ],
    [
      "S6",
      approvedBy({ ci: ci({ state: "cancelled", cancelled: ["test"] }) }),
      "waiting-ci",
      ["Approved by ada", "1 check cancelled"],
    ],
    [
      "S7",
      approvedBy({ ci: ci({ state: "pending", pending: ["test"] }) }),
      "waiting-ci",
      ["Approved by ada", "1 check running"],
    ],
    [
      "S7",
      approvedBy({ ci: ci({ state: "none", passed: 0 }) }),
      "waiting-ci",
      ["Approved by ada", "No check results yet"],
    ],
    [
      "S8",
      approvedBy({ mergeable: "UNKNOWN" }),
      "ready-to-merge",
      ["Approved by ada", "Mergeability not computed yet", "CI green"],
    ],
    [
      "S9",
      { ci: ci({ state: "pending", pending: ["test"] }) },
      "ready-for-review",
      ["No current approval", "CI running"],
    ],
  ] as const)("%s: gives the status and its reasons", (_row, overrides, status, reasons) => {
    expect(classify(overrides)).toMatchObject({ status, reasons });
  });
});

describe("signals", () => {
  it("calls a PR without a push for two weeks a modernize candidate", () => {
    expect(classify({ lastPushAt: "2026-09-01T00:00:00Z" }).signals).toEqual([
      "Stale: last push 22 days ago. Modernize candidate",
    ]);
  });

  it("turns stale at 14 days without a push, and then hides the conflict", () => {
    const conflicting = (lastPushAt: string) =>
      classify({ mergeable: "CONFLICTING", lastPushAt }).signals;
    expect(conflicting("2026-09-10T00:00:00Z")).toEqual(["Conflicts with master"]);
    expect(conflicting("2026-09-09T00:00:00Z")).toEqual([
      "Stale: last push 14 days ago. Modernize candidate",
    ]);
  });

  it("names the conflict on a fresh PR instead", () => {
    expect(classify({ mergeable: "CONFLICTING" }).signals).toEqual(["Conflicts with master"]);
  });

  it("counts unresolved threads that await the author's reply by author kind", () => {
    const threads = [humanThread, botThread, botThread, resolved(humanThread)];
    expect(classify({ threads }).signals).toEqual([
      "1 human thread awaiting the author's reply",
      "2 bot threads awaiting the author's reply",
    ]);
  });

  it("repeats Trunk's message", () => {
    const trunk = { managed: true, failed: true, message: "❌ removed from the merge queue" };
    expect(classify({ trunk }).signals).toEqual(["Trunk: ❌ removed from the merge queue"]);
  });
});

describe("group and next action (Postpile own-PR overlay)", () => {
  it("G1: keeps drafts apart and asks to answer their threads first", () => {
    expect(classify({ isDraft: true })).toMatchObject({
      group: "drafts",
      nextAction: "Finish the implementation",
    });
    expect(classify({ isDraft: true, threads: [humanThread] })).toMatchObject({
      group: "drafts",
      nextAction: "Answer 1 thread from alice",
    });
  });

  it("G2: puts blocked PRs on the viewer with the first hard blocker", () => {
    const result = classify({ ci: ci({ state: "failing", failing: ["lint", "test"] }) });
    expect(result).toMatchObject({
      status: "blocked",
      group: "needs-you",
      nextAction: "Fix failing CI: lint, test",
    });
  });

  it("G3: waits on change requesters the viewer asked to re-review", () => {
    const reReview = (requesters: string[]) =>
      classify({
        review: "changes-requested",
        changeRequesters: requesters.map(human),
        requestedReviewers: [...requesters, "team-x"],
      });
    expect(reReview(["ada"])).toMatchObject({
      group: "waiting-on-others",
      nextAction: "ada to re-review",
    });
    expect(reReview(["ada", "sol"]).nextAction).toBe("ada and sol to re-review");
    expect(reReview(["ada", "sol", "kim"]).nextAction).toBe("ada and 2 more to re-review");
  });

  it("G4: keeps a re-requested change request on the viewer while threads or blockers stand", () => {
    const reRequested = {
      review: "changes-requested" as const,
      changeRequesters: [human("ada")],
      requestedReviewers: ["ada"],
    };
    expect(classify({ ...reRequested, threads: [humanThread] })).toMatchObject({
      group: "needs-you",
      nextAction: "Answer 1 thread from alice",
    });
    expect(classify({ ...reRequested, mergeable: "CONFLICTING" })).toMatchObject({
      group: "needs-you",
      nextAction: "Resolve merge conflicts",
    });
  });

  it("G4: leaves a change request on the viewer until every requester is asked again", () => {
    const result = classify({
      review: "changes-requested",
      changeRequesters: [human("ada"), human("sol")],
      requestedReviewers: ["ada"],
    });
    expect(result).toMatchObject({
      group: "needs-you",
      nextAction: "Address the review feedback",
    });
  });

  const fromBob = {
    ...humanThread,
    author: "bob",
    lastAuthor: "bob",
    lastAt: "2026-09-22T12:00:00Z",
  };

  it.each([
    ["last", [humanThread, humanThread, fromBob]],
    ["first", [fromBob, humanThread, humanThread]],
  ])(
    "G4: asks to answer human threads, naming the newest one's author when it comes %s",
    (_position, threads) => {
      expect(classify({ threads })).toMatchObject({
        status: "changes-requested",
        group: "needs-you",
        nextAction: "Answer 3 threads from bob and 1 more",
      });
    },
  );

  it("G4: names who the viewer owes an answer, not who opened the thread", () => {
    const viewerOpened = { ...humanThread, author: VIEWER };
    expect(classify({ threads: [viewerOpened] }).nextAction).toBe("Answer 1 thread from alice");
  });

  it("G4: keeps a hard blocker as the move on a change request", () => {
    const result = classify({
      review: "changes-requested",
      mergeable: "CONFLICTING",
      threads: [humanThread],
    });
    expect(result).toMatchObject({ group: "needs-you", nextAction: "Resolve merge conflicts" });
  });

  it("G5: groups approved PRs with green CI as ready to merge", () => {
    expect(classify({ review: "approved" })).toMatchObject({
      group: "ready-to-merge",
      nextAction: "Comment /trunk merge",
    });
    expect(
      classify({ review: "approved", trunk: { managed: false, failed: false, message: null } }),
    ).toMatchObject({ group: "ready-to-merge", nextAction: "Merge it" });
  });

  it("G6: waits on a maintainer to authorize CI", () => {
    const result = classify({ review: "approved", ci: ci({ state: "awaiting-authorization" }) });
    expect(result).toMatchObject({
      group: "waiting-on-others",
      nextAction: "Ask a maintainer to authorize the CI run",
    });
  });

  it("G7: puts cancelled CI on the viewer", () => {
    const result = classify({
      review: "approved",
      ci: ci({ state: "cancelled", cancelled: ["test"] }),
    });
    expect(result).toMatchObject({
      status: "waiting-ci",
      group: "needs-you",
      nextAction: "Re-run CI, the last runs were cancelled",
    });
  });

  it("G8: waits on running CI", () => {
    const result = classify({
      review: "approved",
      ci: ci({ state: "pending", pending: ["test"] }),
    });
    expect(result).toMatchObject({
      status: "waiting-ci",
      group: "waiting-on-others",
      nextAction: "Wait for CI to finish",
    });
  });

  it("G9: waits on requested reviewers, users before teams", () => {
    expect(classify({ requestedReviewers: ["sol"] })).toMatchObject({
      group: "waiting-on-others",
      nextAction: "Waiting on sol",
    });
    expect(classify({ requestedReviewers: ["sol", "team-x"] }).nextAction).toBe(
      "Waiting on sol and 1 more",
    );
  });

  it("G10: asks the viewer to request review", () => {
    expect(classify()).toMatchObject({ group: "needs-you", nextAction: "Ask for review" });
    expect(
      classify({
        requestedReviewers: ["sol"],
        ci: ci({ state: "cancelled", cancelled: ["test"] }),
      }),
    ).toMatchObject({ group: "needs-you", nextAction: "Re-run CI, then ask for review" });
    expect(
      classify({
        requestedReviewers: ["sol"],
        ci: ci({ state: "awaiting-authorization", awaitingAuthorization: 1 }),
      }),
    ).toMatchObject({
      group: "needs-you",
      nextAction: "Ask for review and CI authorization",
      reasons: ["No current approval", "CI also needs authorization"],
    });
  });
});

describe("refinement", () => {
  it("L1: approved", () => {
    expect(classify({ review: "approved", approvers: [human("ada")] }).refinement).toBe("approved");
  });

  it("L2: human-reviewed once a human other than the viewer reviews or opens a thread", () => {
    expect(classify({ changeRequesters: [human("ada")] }).refinement).toBe("human-reviewed");
    expect(classify({ threads: [resolved(humanThread), botThread] }).refinement).toBe(
      "human-reviewed",
    );
  });

  it("L3: self-reviewed when only bots reviewed", () => {
    expect(classify({ threads: [resolved(botThread)] }).refinement).toBe("self-reviewed");
    expect(classify({ approvers: [{ login: "codex", isBot: true }] }).refinement).toBe(
      "self-reviewed",
    );
  });

  it("L4: raw when nobody but the viewer reviewed", () => {
    expect(classify().refinement).toBe("raw");
    const ownThread = { ...humanThread, author: VIEWER, lastAuthor: VIEWER, awaitingAuthor: false };
    expect(classify({ threads: [ownThread] }).refinement).toBe("raw");
  });
});

describe("counts", () => {
  it("counts awaiting human threads, outdated included, and open and resolved bot findings", () => {
    const result = classify({
      threads: [
        humanThread,
        { ...humanThread, isOutdated: true },
        { ...humanThread, lastAuthor: VIEWER, awaitingAuthor: false },
        resolved(humanThread),
        botThread,
        resolved(botThread),
        resolved(botThread),
      ],
      threadsTruncated: true,
    });
    expect(result.counts).toEqual({
      humanThreadsAwaiting: 2,
      botFindingsOpen: 1,
      botFindingsResolved: 2,
      threadsTruncated: true,
    });
  });
});
