import type { TriagePullRequest } from "@t3tools/contracts";

export interface TriageSearch {
  readonly repository?: string;
  readonly number?: number;
}

function isPullRequestNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseTriageSearch(raw: Record<string, unknown>): TriageSearch {
  const { repository, number } = raw;
  return typeof repository === "string" && repository.length > 0 && isPullRequestNumber(number)
    ? { repository: repository.slice(0, 200), number }
    : {};
}

export function isSelectedPullRequest(
  { key }: Pick<TriagePullRequest, "key">,
  search: TriageSearch,
): boolean {
  return (
    key.number === search.number &&
    key.repository.toLowerCase() === search.repository?.toLowerCase()
  );
}
