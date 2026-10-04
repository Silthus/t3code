import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ThreadPullRequestKey,
} from "@t3tools/contracts";
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
  capabilitiesByEnvironment: ReadonlyMap<
    EnvironmentId,
    Pick<
      ExecutionEnvironmentCapabilities,
      "threadPullRequests" | "threadPullRequestLinking" | "threadPullRequestBranchUnlink"
    >
  >,
) {
  const result = new Map<string, TriageLinkedThread[]>(
    keys.map((key) => [threadPullRequestKeyOf(key), []]),
  );
  const upgrades = new Map<string, Set<EnvironmentId>>();
  for (const shell of shells.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const capabilities = capabilitiesByEnvironment.get(shell.environmentId);
    if (threadPullRequestLinkMode(capabilities) === "unsupported") continue;
    const links = visibleThreadPullRequests(shell.pullRequests);
    const shellKeys = new Set(links.map(threadPullRequestKeyOf));
    if (shell.branchPullRequest != null) {
      const branchKey = threadPullRequestKeyOf(legacyThreadPullRequestKey(shell.branchPullRequest));
      if (
        !shell.pullRequests.some(
          (link) => link.source === "stack-dismissed" && threadPullRequestKeyOf(link) === branchKey,
        )
      ) {
        if (capabilities?.threadPullRequestBranchUnlink === true) shellKeys.add(branchKey);
        else if (!shellKeys.has(branchKey) && result.has(branchKey)) {
          const environments = upgrades.get(branchKey) ?? new Set<EnvironmentId>();
          environments.add(shell.environmentId);
          upgrades.set(branchKey, environments);
        }
      }
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
  return {
    threadsByPullRequest: result,
    upgradeEnvironmentsByPullRequest: new Map(
      [...upgrades].map(([key, environments]) => [key, [...environments]]),
    ),
  };
}
