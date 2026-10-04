import {
  triageProfileText,
  type TriageContext,
  type TriagePullRequest,
  type TriageThreadPreset,
} from "@t3tools/contracts";
export type { TriageThreadPreset } from "@t3tools/contracts";

function defaultPresetPrompt(
  preset: TriageThreadPreset,
  { url, ci }: Pick<TriagePullRequest, "url"> & { ci: Pick<TriagePullRequest["ci"], "failing"> },
  customInstruction = "",
) {
  switch (preset) {
    case "babysit":
      return `/babysit-pr ${url}`;
    case "review-comments":
      return `Address the unresolved review comments on ${url}. Reply to each thread or fix the code, then push.`;
    case "fix-ci":
      return `Fix the failing CI on ${url}${ci.failing.length > 0 ? `: ${ci.failing.join(", ")}` : ""}. Push the fix.`;
    case "modernize":
      return `/modernize-pr ${url}`;
    case "qa-swarm":
      return `/qa-swarm ${url}`;
    case "custom":
      return `${customInstruction}\n\n${url}`;
  }
}

export function presetPrompt(
  preset: TriageThreadPreset,
  pr: Pick<TriagePullRequest, "url"> & { ci: Pick<TriagePullRequest["ci"], "failing"> },
  customInstruction = "",
  context: TriageContext = {},
) {
  const profile = triageProfileText(context);
  const action = context.actions?.[preset]?.trim();
  return [
    defaultPresetPrompt(preset, pr, customInstruction),
    profile ? `Authored profile:\n${profile}` : "",
    action ? `Additional action instructions:\n${action}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
