import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadPullRequestKey } from "./orchestration.ts";

export const TRIAGE_STATUSES = [
  "blocked",
  "changes-requested",
  "ready-to-merge",
  "waiting-ci-authorization",
  "waiting-ci",
  "ready-for-review",
  "draft",
] as const;
export const TriageStatus = Schema.Literals(TRIAGE_STATUSES);
export type TriageStatus = typeof TriageStatus.Type;

export const TRIAGE_GROUPS = [
  "needs-you",
  "ready-to-merge",
  "waiting-on-others",
  "drafts",
] as const;
export const TriageGroup = Schema.Literals(TRIAGE_GROUPS);
export type TriageGroup = typeof TriageGroup.Type;

export const TriageRefinement = Schema.Literals([
  "raw",
  "self-reviewed",
  "human-reviewed",
  "approved",
]);
export type TriageRefinement = typeof TriageRefinement.Type;

export const TriageCiState = Schema.Literals([
  "green",
  "pending",
  "awaiting-authorization",
  "cancelled",
  "failing",
  "none",
]);
export type TriageCiState = typeof TriageCiState.Type;

export const TriageReviewState = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
  "none",
]);
export type TriageReviewState = typeof TriageReviewState.Type;

export const TriageMergeable = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
export type TriageMergeable = typeof TriageMergeable.Type;

export const TriageRisk = Schema.Literals(["low", "medium", "high"]);
export type TriageRisk = typeof TriageRisk.Type;

export const TriageJudgementBasis = Schema.Literals(["full diff", "diff excerpt", "file list"]);
export type TriageJudgementBasis = typeof TriageJudgementBasis.Type;

export const TriageJudgement = Schema.Struct({
  risk: TriageRisk,
  riskReason: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  basis: TriageJudgementBasis,
  headSha: TrimmedNonEmptyString,
  judgedAt: IsoDateTime,
});
export type TriageJudgement = typeof TriageJudgement.Type;

export const TriageJudgementState = Schema.Union([
  Schema.TaggedStruct("ready", { judgement: TriageJudgement }),
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("not-requested", {}),
  Schema.TaggedStruct("unavailable", { reason: Schema.String }),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
]);
export type TriageJudgementState = typeof TriageJudgementState.Type;

export const TriageCounts = Schema.Struct({
  humanThreadsAwaiting: NonNegativeInt,
  botFindingsOpen: NonNegativeInt,
  botFindingsResolved: NonNegativeInt,
  threadsTruncated: Schema.Boolean,
});
export type TriageCounts = typeof TriageCounts.Type;

export const TriagePullRequest = Schema.Struct({
  key: ThreadPullRequestKey,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  headSha: TrimmedNonEmptyString,
  baseRef: Schema.String,
  headRef: Schema.String,
  updatedAt: IsoDateTime,
  lastPushAt: IsoDateTime,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  review: TriageReviewState,
  ci: Schema.Struct({ state: TriageCiState, failing: Schema.Array(Schema.String) }),
  mergeable: TriageMergeable,
  requestedReviewers: Schema.Array(Schema.String),
  status: TriageStatus,
  group: TriageGroup,
  nextAction: TrimmedNonEmptyString,
  blockers: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
  signals: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  refinement: TriageRefinement,
  counts: TriageCounts,
  judgement: TriageJudgementState,
});
export type TriagePullRequest = typeof TriagePullRequest.Type;

export const TriageReport = Schema.Struct({
  viewer: Schema.String,
  fetchedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(TriagePullRequest),
});
export type TriageReport = typeof TriageReport.Type;

export const TriageReportInput = Schema.Struct({ refresh: Schema.Boolean });
export type TriageReportInput = typeof TriageReportInput.Type;

export const TriageAssessInput = ThreadPullRequestKey;
export type TriageAssessInput = typeof TriageAssessInput.Type;
