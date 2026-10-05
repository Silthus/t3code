import {
  DEFAULT_TRIAGE_PREFERENCES,
  resolveTriageOwner,
  TRIAGE_STATUSES,
  type TriagePreferences,
  type TriagePullRequest,
} from "@t3tools/contracts";

export const TRIAGE_QUEUE_LABELS = {
  "needs-my-action": "Needs my action",
  "needs-team-action": "Needs team's action",
} as const;
export type TriageQueue = keyof typeof TRIAGE_QUEUE_LABELS;
export interface TriagePullRequestGroup {
  readonly group: TriageQueue;
  readonly pullRequests: ReadonlyArray<TriagePullRequest>;
}

export function compareTriagePullRequests(
  left: TriagePullRequest,
  right: TriagePullRequest,
): number {
  const urgency = TRIAGE_STATUSES.indexOf(left.status) - TRIAGE_STATUSES.indexOf(right.status);
  return (
    urgency ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.key.host.localeCompare(right.key.host) ||
    left.key.repository.localeCompare(right.key.repository) ||
    left.key.number - right.key.number
  );
}

export function effectiveTriageActions(
  pr: TriagePullRequest,
  preferences: TriagePreferences = DEFAULT_TRIAGE_PREFERENCES,
) {
  return (pr.pendingActions ?? []).map((action) => ({
    ...action,
    owner: resolveTriageOwner(preferences, pr.key, action.kind),
  }));
}

export function groupTriagePullRequests(
  pullRequests: ReadonlyArray<TriagePullRequest>,
  preferences: TriagePreferences = DEFAULT_TRIAGE_PREFERENCES,
): ReadonlyArray<TriagePullRequestGroup> {
  const groupOf = (pr: TriagePullRequest) =>
    effectiveTriageActions(pr, preferences).some(({ owner }) => owner === "author")
      ? "needs-my-action"
      : "needs-team-action";
  return (Object.keys(TRIAGE_QUEUE_LABELS) as TriageQueue[])
    .map((group) => ({
      group,
      pullRequests: pullRequests
        .filter((pr) => pr.pendingActions !== undefined && groupOf(pr) === group)
        .toSorted(compareTriagePullRequests),
    }))
    .filter((entry) => entry.pullRequests.length > 0);
}
