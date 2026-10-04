import type {
  TriageAssessInput,
  TriageJudgementState,
  TriagePullRequest,
  TriageReport,
  TriageReportInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { makeJudgements } from "./judgement.ts";

import { classifyTriage } from "./classify.ts";
import { toFacts } from "./facts.ts";
import type { TriageFacts } from "./facts.types.ts";
import { makeOpenPullRequestSearch, type TriageSearch } from "./TriageGitHub.ts";

const FRESH_FOR = Duration.minutes(2);

export class TriageService extends Context.Service<
  TriageService,
  {
    /** The viewer's open PRs, classified. Never fails: a failed read keeps the last good PRs. */
    readonly report: (
      input: TriageReportInput,
      authority: "read" | "operate",
    ) => Effect.Effect<TriageReport>;
    readonly assess: (key: TriageAssessInput) => Effect.Effect<TriageJudgementState>;
    readonly awaitJudgement: (key: TriageAssessInput) => Effect.Effect<TriageJudgementState>;
  }
>()("t3/fork/triage/TriageService") {}

interface Snapshot {
  readonly report: TriageReport;
  readonly readAt: number | null;
}

const EMPTY: Snapshot = {
  report: { viewer: "", fetchedAt: null, error: null, pullRequests: [] },
  readAt: null,
};

const make = Effect.gen(function* () {
  const search = yield* makeOpenPullRequestSearch;
  const judgements = yield* makeJudgements;
  const snapshot = yield* Ref.make(EMPTY);
  const inFlight = yield* Ref.make<Deferred.Deferred<TriageReport> | null>(null);

  const gate = yield* Semaphore.make(1);
  const read = (authority: "read" | "operate") =>
    Effect.gen(function* () {
      const result = yield* Effect.result(search());
      const now = yield* Clock.currentTimeMillis;
      return yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(snapshot);
          const next =
            result._tag === "Success"
              ? { report: reportOf(result.success, now), readAt: now }
              : { report: { ...previous.report, error: result.failure.message }, readAt: now };
          if (result._tag === "Success")
            yield* judgements.synchronize(next.report.pullRequests, {
              automatic: authority === "operate",
              retry: true,
            });
          yield* Ref.set(snapshot, next);
          return next.report;
        }),
      );
    });

  const sharedRead = (authority: "read" | "operate") =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* Deferred.make<TriageReport>();
        const joined = yield* Ref.modify(inFlight, (current) =>
          current === null ? [created, created] : [current, current],
        );
        if (joined === created) {
          yield* read(authority).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Deferred.done(created, exit)),
            Effect.ensuring(Ref.set(inFlight, null)),
          );
        }
        return yield* restore(Deferred.await(joined));
      }),
    );

  const report = Effect.fn("TriageService.report")(function* (
    input: TriageReportInput,
    authority: "read" | "operate",
  ) {
    const { readAt } = yield* Ref.get(snapshot);
    const now = yield* Clock.currentTimeMillis;
    const fresh = readAt !== null && now - readAt < Duration.toMillis(FRESH_FOR);
    if (input.refresh || !fresh) yield* sharedRead(authority);
    return yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const { report: current } = yield* Ref.get(snapshot);
        yield* judgements.synchronize(current.pullRequests, {
          automatic: authority === "operate" && current.error === null,
          retry: false,
        });
        return {
          ...current,
          pullRequests: current.pullRequests.map((pr) => ({
            ...pr,
            judgement: judgements.state(pr),
          })),
        };
      }),
    );
  });

  const find = (key: TriageAssessInput) =>
    Ref.get(snapshot).pipe(
      Effect.map(({ report }) =>
        report.pullRequests.find(
          (pr) =>
            pr.key.host === key.host &&
            pr.key.repository === key.repository &&
            pr.key.number === key.number,
        ),
      ),
    );
  const missing = {
    _tag: "failed",
    reason: "This PR is no longer in the triage report. Refresh the list.",
  } as const;
  return TriageService.of({
    report,
    assess: (key) =>
      gate.withPermits(1)(
        find(key).pipe(
          Effect.flatMap((pr) => (pr ? judgements.assess(pr) : Effect.succeed(missing))),
        ),
      ),
    awaitJudgement: (key) =>
      find(key).pipe(
        Effect.flatMap((pr) => (pr ? judgements.awaitJudgement(pr) : Effect.succeed(missing))),
      ),
  });
});

export const layer = Layer.effect(TriageService, make);

function reportOf(search: TriageSearch, now: number): TriageReport {
  return {
    viewer: search.viewer,
    fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    error: null,
    pullRequests: search.pullRequests.map((node) =>
      triagePullRequest(toFacts(node, search.viewer), search.viewer, now),
    ),
  };
}

function triagePullRequest(facts: TriageFacts, viewer: string, now: number): TriagePullRequest {
  return {
    key: facts.key,
    url: facts.url,
    title: facts.title,
    isDraft: facts.isDraft,
    headSha: facts.headSha,
    baseRef: facts.baseRef,
    headRef: facts.headRef,
    updatedAt: facts.updatedAt,
    lastPushAt: facts.lastPushAt,
    additions: facts.additions,
    deletions: facts.deletions,
    changedFiles: facts.changedFiles,
    review: facts.review,
    ci: { state: facts.ci.state, failing: facts.ci.failing },
    mergeable: facts.mergeable,
    requestedReviewers: facts.requestedReviewers,
    ...classifyTriage(facts, viewer, now),
    judgement: { _tag: "not-requested" },
  };
}
