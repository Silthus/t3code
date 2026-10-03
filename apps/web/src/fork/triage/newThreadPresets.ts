import type { TriagePullRequest } from "@t3tools/contracts";

export type TriageThreadPreset =
  | "babysit"
  | "review-comments"
  | "fix-ci"
  | "modernize"
  | "qa-swarm"
  | "custom";

export function presetPrompt(
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
