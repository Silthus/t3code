import * as Schema from "effect/Schema";

export const TRIAGE_PROFILE_SECTIONS = [
  ["aboutMe", "About me"],
  ["ownership", "What I own"],
  ["routing", "What gets routed to me"],
  ["quiet", "What to ignore or keep quiet"],
  ["preferences", "Preferences"],
] as const;
export const TRIAGE_PRESETS = [
  ["babysit", "Babysit"],
  ["review-comments", "Address review comments"],
  ["fix-ci", "Fix CI"],
  ["modernize", "Modernize / resolve conflicts"],
  ["qa-swarm", "QA swarm"],
  ["custom", "Custom instruction"],
] as const;
export type TriageThreadPreset = (typeof TRIAGE_PRESETS)[number][0];
const AuthoredText = Schema.String.check(Schema.isMaxLength(8000));
const ActionInstructions = Schema.Struct({
  babysit: Schema.optionalKey(AuthoredText),
  "review-comments": Schema.optionalKey(AuthoredText),
  "fix-ci": Schema.optionalKey(AuthoredText),
  modernize: Schema.optionalKey(AuthoredText),
  "qa-swarm": Schema.optionalKey(AuthoredText),
  custom: Schema.optionalKey(AuthoredText),
});
export const TriageContext = Schema.Struct({
  aboutMe: Schema.optionalKey(AuthoredText),
  ownership: Schema.optionalKey(AuthoredText),
  routing: Schema.optionalKey(AuthoredText),
  quiet: Schema.optionalKey(AuthoredText),
  preferences: Schema.optionalKey(AuthoredText),
  assessment: Schema.optionalKey(AuthoredText),
  actions: Schema.optionalKey(ActionInstructions),
});
export type TriageContext = typeof TriageContext.Type;
export const TriagePreferences = Schema.Struct({
  global: TriageContext,
  repositories: Schema.Record(Schema.String, TriageContext),
});
export type TriagePreferences = typeof TriagePreferences.Type;
export const DEFAULT_TRIAGE_PREFERENCES: TriagePreferences = { global: {}, repositories: {} };

export function triageRepositoryId(key: { readonly host: string; readonly repository: string }) {
  return `${key.host}/${key.repository}`.toLowerCase();
}

export function resolveTriageContext(
  settings: TriagePreferences = DEFAULT_TRIAGE_PREFERENCES,
  key: { readonly host: string; readonly repository: string },
): TriageContext {
  const global = settings.global;
  const repository = settings.repositories[triageRepositoryId(key)];
  const text = (field: (typeof TRIAGE_PROFILE_SECTIONS)[number][0] | "assessment") =>
    repository?.[field]?.trim() || global[field]?.trim() || "";
  return {
    ...Object.fromEntries(TRIAGE_PROFILE_SECTIONS.map(([field]) => [field, text(field)])),
    assessment: text("assessment"),
    actions: Object.fromEntries(
      TRIAGE_PRESETS.map(([preset]) => [
        preset,
        repository?.actions?.[preset]?.trim() || global.actions?.[preset]?.trim() || "",
      ]),
    ),
  };
}

export function triageProfileText(context: TriageContext) {
  return TRIAGE_PROFILE_SECTIONS.flatMap(([field, label]) =>
    context[field]?.trim() ? [`${label}:\n${context[field]!.trim()}`] : [],
  ).join("\n\n");
}
