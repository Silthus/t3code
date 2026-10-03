import { assert, it } from "@effect/vitest";
import type { TriagePullRequest, TriageReport } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../../sourceControl/githubGraphQlBudget.ts";
import recordedPage from "./fixtures/searchPage.json" with { type: "json" };
import * as TriageService from "./TriageService.ts";

interface FakeOutput {
  readonly stdout: string;
  readonly stdoutTruncated?: boolean;
}

type Answer = Effect.Effect<FakeOutput, GitHubCli.GitHubCliError>;

const GraphQlRequest = Schema.Struct({
  query: Schema.String,
  variables: Schema.Struct({ q: Schema.String, after: Schema.optionalKey(Schema.String) }),
});
const decodeGraphQlRequest = Schema.decodeUnknownSync(Schema.fromJsonString(GraphQlRequest));

interface GitHubRequest extends Schema.Schema.Type<typeof GraphQlRequest> {
  readonly args: ReadonlyArray<string>;
  readonly acceptNotModified: boolean | undefined;
  readonly at: number;
}

const httpOk = (page: unknown) =>
  `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(page)}`;

const answerPage = (page: unknown): Answer => Effect.succeed({ stdout: httpOk(page) });

const httpFailure = (httpStatus: number): Answer =>
  Effect.fail(
    new GitHubCli.GitHubCliCommandError({ command: "gh", cwd: "/", cause: undefined, httpStatus }),
  );

const recorded = answerPage(recordedPage);

function fakeGitHub(answers: ReadonlyArray<Answer>) {
  const requests: Array<GitHubRequest> = [];
  const github = Layer.mock(GitHubCli.GitHubCli)({
    execute: ({ args, stdin, acceptNotModified }) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) => {
          requests.push({ args, acceptNotModified, at, ...decodeGraphQlRequest(stdin) });
          return answers[Math.min(requests.length, answers.length) - 1]!;
        }),
        Effect.map((output) => ({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          ...output,
        })),
      ),
  });
  const layer = TriageService.layer.pipe(
    Layer.provide(Layer.merge(github, GitHubGraphQlBudget.layer)),
  );
  return { requests, layer };
}

const report = (refresh = false) =>
  TriageService.TriageService.use((triage) => triage.report({ refresh }));

const pullRequest = (current: TriageReport, number: number): TriagePullRequest => {
  const found = current.pullRequests.find((candidate) => candidate.key.number === number);
  assert.isDefined(found, `PR #${number} is in the report`);
  return found!;
};

const [approvedNode, ...otherNodes] = recordedPage.data.search.nodes;

const pageOf = (nodes: ReadonlyArray<unknown>, hasNextPage: boolean, endCursor: string | null) => ({
  data: {
    ...recordedPage.data,
    search: { pageInfo: { hasNextPage, endCursor }, nodes },
  },
});

it.effect("classifies every PR of the recorded search page into the report", () => {
  const github = fakeGitHub([recorded]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.strictEqual(current.viewer, "octo-viewer");
    assert.strictEqual(current.error, null);
    assert.isNotNull(current.fetchedAt);
    assert.deepStrictEqual(
      current.pullRequests.map((pr) => [pr.key.number, pr.status, pr.group, pr.nextAction]),
      [
        [100, "blocked", "needs-you", "Fix failing CI: a check past the first 50"],
        [101, "ready-for-review", "needs-you", "Ask for review and CI authorization"],
        [102, "ready-for-review", "waiting-on-others", "Waiting on a reviewer"],
        [103, "draft", "drafts", "Finish the implementation"],
        [104, "draft", "drafts", "Finish the implementation"],
      ],
    );

    const approved = pullRequest(current, 100);
    assert.deepStrictEqual(approved.key, {
      host: "github.com",
      repository: "acme/app",
      number: 100,
    });
    assert.strictEqual(approved.lastPushAt, "2026-10-01T10:28:38Z");
    assert.deepStrictEqual(approved.blockers, [
      "Fix failing CI: a check past the first 50",
      "Trunk removed the PR from the merge queue",
    ]);
    assert.strictEqual(approved.refinement, "approved");

    assert.strictEqual(pullRequest(current, 101).refinement, "human-reviewed");
    assert.strictEqual(pullRequest(current, 101).counts.humanThreadsAwaiting, 0);
    assert.strictEqual(pullRequest(current, 102).refinement, "self-reviewed");
    assert.strictEqual(pullRequest(current, 102).counts.botFindingsResolved, 1);
    assert.strictEqual(pullRequest(current, 103).counts.botFindingsOpen, 2);
    assert.strictEqual(pullRequest(current, 104).refinement, "raw");

    for (const pr of current.pullRequests) {
      assert.deepStrictEqual(pr.judgement, {
        _tag: "unavailable",
        reason: "Risk judgement is not built yet",
      });
    }

    const [request] = github.requests;
    assert.deepStrictEqual(request!.args, [
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "--include",
      "--input",
      "-",
    ]);
    assert.strictEqual(
      request!.variables.q,
      "is:pr is:open author:@me archived:false sort:updated-desc",
    );
    assert.strictEqual(request!.acceptNotModified, true);
    assert.include(request!.query, "rateLimit { cost limit remaining resetAt }");
    assert.include(request!.query, "search(query: $q, type: ISSUE, first: 25, after: $after)");
  }).pipe(Effect.provide(github.layer));
});

it.effect("follows the search cursor until the last page, skipping hidden results", () => {
  const [first, second, ...rest] = recordedPage.data.search.nodes;
  const github = fakeGitHub([
    answerPage(pageOf([first, second], true, "cursor-2")),
    answerPage(pageOf([null, ...rest], false, "cursor-3")),
  ]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.deepStrictEqual(
      current.pullRequests.map((pr) => pr.key.number),
      [100, 101, 102, 103, 104],
    );
    assert.deepStrictEqual(
      github.requests.map((request) => request.variables.after ?? null),
      [null, "cursor-2"],
    );
  }).pipe(Effect.provide(github.layer));
});

it.effect("serves the cached report for two minutes, and re-reads on refresh", () => {
  const github = fakeGitHub([recorded]);
  return Effect.gen(function* () {
    const first = yield* report();
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(yield* report(), first);
    assert.strictEqual(github.requests.length, 1);

    yield* report(true);
    assert.strictEqual(github.requests.length, 2);

    yield* TestClock.adjust("119 seconds");
    yield* report();
    assert.strictEqual(github.requests.length, 2);

    yield* TestClock.adjust("1 second");
    yield* report();
    assert.strictEqual(github.requests.length, 3);
  }).pipe(Effect.provide(github.layer));
});

it.effect("shares one in-flight read between concurrent callers", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const github = fakeGitHub([Deferred.await(release).pipe(Effect.andThen(recorded))]);
    yield* Effect.gen(function* () {
      const callers = yield* Effect.forEach([true, true, false], (refresh) =>
        report(refresh).pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Deferred.succeed(release, undefined);
      const reports = yield* Fiber.joinAll(callers);

      assert.strictEqual(github.requests.length, 1);
      assert.strictEqual(reports[1], reports[0]);
      assert.strictEqual(reports[2], reports[0]);
    }).pipe(Effect.provide(github.layer));
  }),
);

it.effect("retries a 502 from GitHub after a one second backoff", () => {
  const github = fakeGitHub([httpFailure(502), recorded]);
  return Effect.gen(function* () {
    const read = yield* report().pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 second");
    const current = yield* Fiber.join(read);

    assert.strictEqual(github.requests.length, 2);
    assert.strictEqual(current.error, null);
    assert.lengthOf(current.pullRequests, 5);
  }).pipe(Effect.provide(github.layer));
});

it.effect("retries a GraphQL timeout that GitHub answers with HTTP 200", () => {
  const github = fakeGitHub([httpFailure(200), recorded]);
  return Effect.gen(function* () {
    const read = yield* report().pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 second");
    const current = yield* Fiber.join(read);

    assert.strictEqual(github.requests.length, 2);
    assert.strictEqual(current.error, null);
    assert.lengthOf(current.pullRequests, 5);
  }).pipe(Effect.provide(github.layer));
});

it.effect.each([
  { status: 504, error: "GitHub read failed: GitHub CLI command failed (HTTP 504)." },
  {
    status: 200,
    error: "GitHub read failed: GitHub answered the search with an error, likely a timeout.",
  },
] as const)(
  "gives up after four attempts when GitHub keeps answering $status",
  ({ status, error }) => {
    const github = fakeGitHub([httpFailure(status)]);
    return Effect.gen(function* () {
      const read = yield* report().pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("6 seconds");
      const current = yield* Fiber.join(read);

      assert.deepStrictEqual(
        github.requests.map((request) => request.at),
        [0, 1_000, 3_000, 6_000],
      );
      assert.strictEqual(current.error, error);
      assert.deepStrictEqual(current.pullRequests, []);
      assert.isNull(current.fetchedAt);
    }).pipe(Effect.provide(github.layer));
  },
);

it.effect("keeps the last good PRs and reports the error when a later read fails", () => {
  const github = fakeGitHub([
    recorded,
    Effect.fail(
      new GitHubCli.GitHubCliAuthenticationError({ command: "gh", cwd: "/", cause: undefined }),
    ),
  ]);
  return Effect.gen(function* () {
    const good = yield* report();
    const failed = yield* report(true);

    assert.strictEqual(github.requests.length, 2);
    assert.strictEqual(
      failed.error,
      "GitHub read failed: GitHub CLI is not authenticated. Run `gh auth login` and retry.",
    );
    assert.strictEqual(failed.viewer, good.viewer);
    assert.strictEqual(failed.fetchedAt, good.fetchedAt);
    assert.deepStrictEqual(failed.pullRequests, good.pullRequests);
  }).pipe(Effect.provide(github.layer));
});

it.effect("reports a search page too large to read instead of a decode error", () => {
  const github = fakeGitHub([
    Effect.succeed({ stdout: httpOk(recordedPage).slice(0, 2_000), stdoutTruncated: true }),
  ]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.strictEqual(current.error, "GitHub read failed: GitHub's answer was too large to read.");
  }).pipe(Effect.provide(github.layer));
});

const approvedWithRollup = (state: string, totalCount: number, conclusion: string) => {
  const [commitNode] = approvedNode!.commits.nodes;
  const check = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion };
  return {
    ...approvedNode,
    commits: {
      nodes: [
        {
          commit: {
            ...commitNode!.commit,
            statusCheckRollup: { state, contexts: { totalCount, nodes: [check] } },
          },
        },
      ],
    },
  };
};

it.effect.each([
  {
    reading: "a failed rollup explained by a cancelled run as cancelled CI",
    rollup: "FAILURE",
    totalCount: 1,
    conclusion: "CANCELLED",
    ci: { state: "cancelled", failing: [] },
  },
  {
    reading: "a pending rollup with only passing checks listed as pending CI",
    rollup: "PENDING",
    totalCount: 51,
    conclusion: "SUCCESS",
    ci: { state: "pending", failing: [] },
  },
] as const)("reads $reading", ({ rollup, totalCount, conclusion, ci }) => {
  const node = approvedWithRollup(rollup, totalCount, conclusion);
  const github = fakeGitHub([answerPage(pageOf([node, ...otherNodes], false, "end"))]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.deepStrictEqual(pullRequest(current, 100).ci, ci);
  }).pipe(Effect.provide(github.layer));
});

it.effect("fails the read when GitHub promises another page without a cursor", () => {
  const github = fakeGitHub([answerPage(pageOf(recordedPage.data.search.nodes, true, null))]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.strictEqual(
      current.error,
      "GitHub read failed: GitHub's search promised another page without a cursor.",
    );
    assert.deepStrictEqual(current.pullRequests, []);
  }).pipe(Effect.provide(github.layer));
});

it.effect("fails the read when a PR breaks the report contract", () => {
  const github = fakeGitHub([
    answerPage(pageOf([{ ...approvedNode, additions: -1 }], false, "end")),
  ]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.strictEqual(
      current.error,
      "GitHub read failed: GitHub answered with an unexpected search result.",
    );
  }).pipe(Effect.provide(github.layer));
});

it.effect("points at the gh login when gh fails before GitHub answers", () => {
  const github = fakeGitHub([
    Effect.fail(new GitHubCli.GitHubCliCommandError({ command: "gh", cwd: "/", cause: undefined })),
  ]);
  return Effect.gen(function* () {
    const current = yield* report();

    assert.strictEqual(
      current.error,
      "GitHub read failed: GitHub CLI failed before GitHub answered. Check `gh auth status`.",
    );
  }).pipe(Effect.provide(github.layer));
});
