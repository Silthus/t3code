import {
  TRIAGE_GROUPS,
  TRIAGE_STATUSES,
  type TriageGroup,
  type TriagePullRequest,
} from "@t3tools/contracts";

export interface TriagePullRequestGroup {
  readonly group: TriageGroup;
  readonly pullRequests: ReadonlyArray<TriagePullRequest>;
}

function byUrgencyThenNewest(left: TriagePullRequest, right: TriagePullRequest): number {
  const urgency = TRIAGE_STATUSES.indexOf(left.status) - TRIAGE_STATUSES.indexOf(right.status);
  return urgency !== 0 ? urgency : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

export function groupTriagePullRequests(
  pullRequests: ReadonlyArray<TriagePullRequest>,
): ReadonlyArray<TriagePullRequestGroup> {
  return TRIAGE_GROUPS.map((group) => ({
    group,
    pullRequests: pullRequests.filter((pr) => pr.group === group).toSorted(byUrgencyThenNewest),
  })).filter((entry) => entry.pullRequests.length > 0);
}
