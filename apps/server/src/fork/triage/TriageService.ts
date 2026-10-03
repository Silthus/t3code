import type { TriagePullRequest, TriageReport, TriageReportInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { classifyTriage } from "./classify.ts";
import { toFacts } from "./facts.ts";
import type { TriageFacts } from "./facts.types.ts";
import { makeOpenPullRequestSearch, type TriageSearch } from "./TriageGitHub.ts";

const FRESH_FOR = Duration.minutes(2);
const JUDGEMENT_NOT_BUILT = {
  _tag: "unavailable",
  reason: "Risk judgement is not built yet",
} as const;

export class TriageService extends Context.Service<
  TriageService,
  {
    /** The viewer's open PRs, classified. Never fails: a failed read keeps the last good PRs. */
    readonly report: (input: TriageReportInput) => Effect.Effect<TriageReport>;
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
  const snapshot = yield* Ref.make(EMPTY);
  const inFlight = yield* Ref.make<Deferred.Deferred<TriageReport> | null>(null);

  const read = Effect.gen(function* () {
    const result = yield* Effect.result(search());
    const now = yield* Clock.currentTimeMillis;
    const next = yield* Ref.updateAndGet(snapshot, (previous) =>
      result._tag === "Success"
        ? { report: reportOf(result.success, now), readAt: now }
        : { report: { ...previous.report, error: result.failure.message }, readAt: now },
    );
    return next.report;
  });

  const sharedRead = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<TriageReport>();
      const joined = yield* Ref.modify(inFlight, (current) =>
        current === null ? [created, created] : [current, current],
      );
      if (joined === created) {
        yield* read.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(created, exit)),
          Effect.ensuring(Ref.set(inFlight, null)),
        );
      }
      return yield* restore(Deferred.await(joined));
    }),
  );

  const report = Effect.fn("TriageService.report")(function* (input: TriageReportInput) {
    const { report: cached, readAt } = yield* Ref.get(snapshot);
    const now = yield* Clock.currentTimeMillis;
    const fresh = readAt !== null && now - readAt < Duration.toMillis(FRESH_FOR);
    return input.refresh || !fresh ? yield* sharedRead : cached;
  });

  return TriageService.of({ report });
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
    judgement: JUDGEMENT_NOT_BUILT,
  };
}
