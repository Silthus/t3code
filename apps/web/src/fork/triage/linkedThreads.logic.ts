import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadPullRequestKey } from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

export type LinkedThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "pullRequests"
  | "branchPullRequest"
>;

export type TriageLinkedThread = Pick<
  LinkedThreadShell,
  "environmentId" | "title" | "archivedAt"
> & {
  readonly threadId: LinkedThreadShell["id"];
};

export function linkedThreadsByPullRequest(
  shells: ReadonlyArray<LinkedThreadShell>,
  keys: ReadonlyArray<ThreadPullRequestKey>,
): ReadonlyMap<string, ReadonlyArray<TriageLinkedThread>> {
  const result = new Map<string, TriageLinkedThread[]>(
    keys.map((key) => [threadPullRequestKeyOf(key), []]),
  );
  for (const shell of shells.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const links = visibleThreadPullRequests(shell.pullRequests);
    const shellKeys = new Set(links.map(threadPullRequestKeyOf));
    if (shell.branchPullRequest != null) {
      const branchKey = threadPullRequestKeyOf(legacyThreadPullRequestKey(shell.branchPullRequest));
      if (
        !shell.pullRequests.some(
          (link) => link.source === "stack-dismissed" && threadPullRequestKeyOf(link) === branchKey,
        )
      )
        shellKeys.add(branchKey);
    }
    for (const key of shellKeys) {
      result.get(key)?.push({
        environmentId: shell.environmentId,
        threadId: shell.id,
        title: shell.title,
        archivedAt: shell.archivedAt,
      });
    }
  }
  return result;
}
