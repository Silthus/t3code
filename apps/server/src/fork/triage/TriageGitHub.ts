import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { encodeGraphQlRequestJson } from "../../pullRequest/gitHubPullRequestJson.ts";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../../sourceControl/githubGraphQlBudget.ts";
import type * as SourceControlRateLimit from "../../sourceControl/SourceControlRateLimit.ts";

export const TRIAGE_HOST = "github.com";
const SEARCH_QUERY = "is:pr is:open author:@me archived:false sort:updated-desc";
const SEARCH_PAGE_SIZE = 25;
export const CHECKS_PER_PAGE = 50;
export const THREADS_PER_PAGE = 50;
const MAX_ATTEMPTS = 4;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const GRAPHQL_ERROR_STATUS = 200;
const RETRYABLE_STATUSES = new Set([GRAPHQL_ERROR_STATUS, 502, 504]);

const SEARCH_DOCUMENT = `query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url isDraft headRefOid createdAt updatedAt baseRefName headRefName
      additions deletions changedFiles
      repository { nameWithOwner }
      reviewDecision mergeable
      commits(last: 1) { nodes { commit { committedDate
        statusCheckRollup { state contexts(first: ${CHECKS_PER_PAGE}) { totalCount nodes { __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state } } } }
        checkSuites(first: 20) { nodes { status conclusion } } } } }
      latestOpinionatedReviews(first: 20) { nodes { state author { __typename login } } }
      reviewRequests(first: 10) { totalCount nodes { requestedReviewer { __typename
        ... on User { login } ... on Bot { login } ... on Team { name } } } }
      reviewThreads(first: ${THREADS_PER_PAGE}) { totalCount nodes { isResolved isOutdated path
        first: comments(first: 1) { nodes { author { __typename login } } }
        last: comments(last: 1) { nodes { author { __typename login } createdAt } } } }
      comments(last: 10) { nodes { author { __typename login } body createdAt } }
    } }
  }
}`;

const Actor = Schema.NullOr(Schema.Struct({ __typename: Schema.String, login: Schema.String }));
export type TriageActor = typeof Actor.Type;

const Nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) });

const CheckContext = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
});

const PullRequestNode = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  headRefOid: TrimmedNonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  repository: Schema.Struct({ nameWithOwner: TrimmedNonEmptyString }),
  reviewDecision: Schema.NullOr(Schema.String),
  mergeable: Schema.String,
  commits: Nodes(
    Schema.Struct({
      commit: Schema.Struct({
        committedDate: Schema.NullOr(Schema.String),
        statusCheckRollup: Schema.NullOr(
          Schema.Struct({
            state: Schema.String,
            contexts: Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(CheckContext) }),
          }),
        ),
        checkSuites: Nodes(
          Schema.Struct({ status: Schema.String, conclusion: Schema.NullOr(Schema.String) }),
        ),
      }),
    }),
  ),
  latestOpinionatedReviews: Nodes(Schema.Struct({ state: Schema.String, author: Actor })),
  reviewRequests: Nodes(
    Schema.Struct({
      requestedReviewer: Schema.NullOr(
        Schema.Struct({
          __typename: Schema.String,
          login: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  reviewThreads: Schema.Struct({
    totalCount: Schema.Int,
    nodes: Schema.Array(
      Schema.Struct({
        isResolved: Schema.Boolean,
        isOutdated: Schema.Boolean,
        path: Schema.NullOr(Schema.String),
        first: Nodes(Schema.Struct({ author: Actor })),
        last: Nodes(Schema.Struct({ author: Actor, createdAt: Schema.String })),
      }),
    ),
  }),
  comments: Nodes(Schema.Struct({ author: Actor, body: Schema.String, createdAt: Schema.String })),
});
export type TriagePullRequestNode = typeof PullRequestNode.Type;

const SearchPage = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    search: Schema.Struct({
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      nodes: Schema.Array(Schema.NullOr(PullRequestNode)),
    }),
  }),
});
type SearchPage = typeof SearchPage.Type;

const decodeSearchPage = decodeJsonResult(SearchPage);

export class TriageReadError extends Schema.TaggedError<TriageReadError>()("TriageReadError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `GitHub read failed: ${this.detail}`;
  }
}

export interface TriageSearch {
  readonly viewer: string;
  readonly pullRequests: ReadonlyArray<TriagePullRequestNode>;
}

export const makeOpenPullRequestSearch = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;

  const execute = (query: string, after: string | null) =>
    github.execute({
      cwd: process.cwd(),
      args: ["api", "graphql", "--hostname", TRIAGE_HOST, "--include", "--input", "-"],
      stdin: encodeGraphQlRequestJson({
        query,
        variables: after === null ? { q: SEARCH_QUERY } : { q: SEARCH_QUERY, after },
      }),
      acceptNotModified: true,
      maxOutputBytes: MAX_PAGE_BYTES,
    });

  const readPage = (after: string | null) =>
    budget.query(TRIAGE_HOST, SEARCH_DOCUMENT).pipe(
      Effect.flatMap((query) => retryTimeouts(execute(query, after))),
      Effect.mapError((error) => new TriageReadError({ detail: failureDetail(error) })),
      Effect.filterOrFail(
        (output) => !output.stdoutTruncated,
        () => new TriageReadError({ detail: "GitHub's answer was too large to read." }),
      ),
      Effect.map((output) => responseBody(output.stdout)),
      Effect.tap((body) => budget.observe(TRIAGE_HOST, body)),
      Effect.flatMap(decodePage),
    );

  return () =>
    Effect.gen(function* () {
      let page = yield* readPage(null);
      const pullRequests = visibleNodes(page);
      while (page.data.search.pageInfo.hasNextPage) {
        page = yield* readPage(yield* nextCursor(page));
        pullRequests.push(...visibleNodes(page));
      }
      return { viewer: page.data.viewer.login, pullRequests } satisfies TriageSearch;
    });
});

function nextCursor(page: SearchPage): Effect.Effect<string, TriageReadError> {
  const cursor = page.data.search.pageInfo.endCursor;
  return cursor === null
    ? Effect.fail(
        new TriageReadError({ detail: "GitHub's search promised another page without a cursor." }),
      )
    : Effect.succeed(cursor);
}

function failureDetail(
  error: GitHubCli.GitHubCliError | SourceControlRateLimit.SourceControlRateLimitPausedError,
): string {
  if (error._tag !== "GitHubCliCommandError") return error.detail;
  if (error.httpStatus === undefined) {
    return "GitHub CLI failed before GitHub answered. Check `gh auth status`.";
  }
  return error.httpStatus === GRAPHQL_ERROR_STATUS
    ? "GitHub answered the search with an error, likely a timeout."
    : `GitHub CLI command failed (HTTP ${error.httpStatus}).`;
}

function visibleNodes(page: SearchPage): Array<TriagePullRequestNode> {
  return page.data.search.nodes.filter((node) => node !== null);
}

function retryTimeouts<A>(
  read: Effect.Effect<A, GitHubCli.GitHubCliError>,
  attempt = 1,
): Effect.Effect<A, GitHubCli.GitHubCliError> {
  return read.pipe(
    Effect.catchIf(
      (error) => attempt < MAX_ATTEMPTS && isRetryable(error),
      () =>
        Effect.sleep(Duration.seconds(attempt)).pipe(
          Effect.andThen(retryTimeouts(read, attempt + 1)),
        ),
    ),
  );
}

function isRetryable(error: GitHubCli.GitHubCliError): boolean {
  return error._tag === "GitHubCliCommandError" && RETRYABLE_STATUSES.has(error.httpStatus ?? 0);
}

function responseBody(included: string): string {
  const headersEnd = included.search(/\r?\n\r?\n/);
  return headersEnd < 0 ? included : included.slice(headersEnd).trim();
}

function decodePage(body: string): Effect.Effect<SearchPage, TriageReadError> {
  const decoded = decodeSearchPage(body);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new TriageReadError({ detail: "GitHub answered with an unexpected search result." }),
      );
}
