import * as Schema from "effect/Schema";

const ForkTriageDetails = Schema.Record(Schema.String, Schema.Unknown);

export const ForkTriageItemKind = Schema.Literals(["issue", "pull-request"]);
export const ForkTriageLifecycle = Schema.Literals(["open", "draft", "closed", "merged"]);
export const ForkTriageClassification = Schema.Literals([
  "ready-maintainer",
  "review",
  "draft",
  "blocked",
  "unknown",
  "issue",
  "stale-closed",
  "replaced",
]);
export const ForkTriageCertainty = Schema.Literals(["factual", "inferred", "uncertain", "stale"]);

export const ForkTriageBlocker = Schema.Struct({
  code: Schema.String,
  label: Schema.String,
  actor: Schema.NullOr(Schema.String),
  evidenceUrls: Schema.Array(Schema.String),
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageEvidence = Schema.Struct({
  sourceId: Schema.String,
  url: Schema.String,
  excerpt: Schema.String,
  author: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageRelation = Schema.Struct({
  kind: Schema.Literals([
    "parent",
    "child",
    "depends-on",
    "blocks",
    "replaces",
    "replaced-by",
    "references",
  ]),
  target: Schema.String,
  source: Schema.Literals(["github-native", "text-candidate"]),
  evidenceUrl: Schema.String,
  certainty: ForkTriageCertainty,
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageJudgment = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  value: Schema.Unknown,
  certainty: ForkTriageCertainty,
  confidence: Schema.NullOr(Schema.Finite),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  evidenceUrls: Schema.Array(Schema.String),
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageItemError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  source: Schema.String,
  at: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageItem = Schema.Struct({
  repo: Schema.String,
  number: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  kind: ForkTriageItemKind,
  lifecycle: ForkTriageLifecycle,
  classification: ForkTriageClassification,
  blockers: Schema.Array(ForkTriageBlocker),
  nextActors: Schema.Array(Schema.String),
  evidence: Schema.Array(ForkTriageEvidence),
  lastSuccessfulRefresh: Schema.NullOr(Schema.String),
  errors: Schema.Array(ForkTriageItemError),
  certainty: ForkTriageCertainty,
  relations: Schema.Array(ForkTriageRelation),
  judgments: Schema.Array(ForkTriageJudgment),
  details: Schema.optionalKey(ForkTriageDetails),
});
export type ForkTriageItem = typeof ForkTriageItem.Type;
export const ForkTriageChange = Schema.Struct({
  item: Schema.String,
  detectedAt: Schema.String,
  kind: Schema.Literals(["added", "removed", "changed"]),
  fields: Schema.Array(Schema.String),
  before: Schema.optionalKey(ForkTriageDetails),
  after: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  source: Schema.String,
  at: Schema.String,
  retryable: Schema.Boolean,
  item: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(ForkTriageDetails),
});
export const ForkTriageUsage = Schema.Struct({
  details: Schema.optionalKey(ForkTriageDetails),
  githubRequests: Schema.Finite,
  githubPages: Schema.Finite,
  inferenceRequests: Schema.Finite,
  inferenceCacheHits: Schema.Finite,
  inferenceInputCharacters: Schema.Finite,
  inferenceBudget: Schema.Finite,
  inferenceBudgetRemaining: Schema.Finite,
  truncatedConnections: Schema.Finite,
});
export const ForkTriageConfigSummary = Schema.Struct({
  scopes: Schema.Array(Schema.String),
  refreshIntervalMinutes: Schema.Finite,
  staleAfterMinutes: Schema.Finite,
  githubPageLimit: Schema.Finite,
  inferenceEnabled: Schema.Boolean,
  inferenceProvider: Schema.String,
  inferenceModel: Schema.String,
  mergePolicies: Schema.Array(Schema.String),
});

/** A redacted monitor snapshot that can cross an authenticated environment connection. */
export const ForkTriageReport = Schema.Struct({
  generatedAt: Schema.String,
  lastScanAt: Schema.NullOr(Schema.String),
  items: Schema.Array(ForkTriageItem),
  changes: Schema.Array(ForkTriageChange),
  errors: Schema.Array(ForkTriageError),
  usage: ForkTriageUsage,
  configSummary: ForkTriageConfigSummary,
});
export type ForkTriageReport = typeof ForkTriageReport.Type;

export const ForkTriageRefreshResult = Schema.Struct({
  report: ForkTriageReport,
});
export type ForkTriageRefreshResult = typeof ForkTriageRefreshResult.Type;
