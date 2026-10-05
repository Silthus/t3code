import * as Schema from "effect/Schema";

export const TRIAGE_ACTION_KINDS = [
  ["finish", "Finish implementation", "author"],
  ["conflicts", "Resolve conflicts", "author"],
  ["fix-ci", "Fix failing CI", "author"],
  ["feedback", "Address reviewer feedback", "author"],
  ["judge-bots", "Judge bot findings", "author"],
  ["rerun-ci", "Re-run cancelled CI", "author"],
  ["review", "Review or re-review", "team"],
  ["authorize-ci", "Authorize CI", "team"],
  ["merge", "Merge", "team"],
] as const;
export const TriageActionKind = Schema.Literals(TRIAGE_ACTION_KINDS.map(([kind]) => kind));
export type TriageActionKind = typeof TriageActionKind.Type;
export const TriageActionOwner = Schema.Literals(["author", "team"]);
export type TriageActionOwner = typeof TriageActionOwner.Type;
export const TriageActionOwners = Schema.Struct({
  finish: Schema.optionalKey(TriageActionOwner),
  conflicts: Schema.optionalKey(TriageActionOwner),
  "fix-ci": Schema.optionalKey(TriageActionOwner),
  feedback: Schema.optionalKey(TriageActionOwner),
  "judge-bots": Schema.optionalKey(TriageActionOwner),
  "rerun-ci": Schema.optionalKey(TriageActionOwner),
  review: Schema.optionalKey(TriageActionOwner),
  "authorize-ci": Schema.optionalKey(TriageActionOwner),
  merge: Schema.optionalKey(TriageActionOwner),
});
export type TriageActionOwners = typeof TriageActionOwners.Type;
export const TriagePendingAction = Schema.Struct({ kind: TriageActionKind, label: Schema.String });
export type TriagePendingAction = typeof TriagePendingAction.Type;
