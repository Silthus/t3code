import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, PullRequestRef, TriagePullRequest } from "@t3tools/contracts";

import { findProjectForChangeRequest } from "~/lib/openPullRequestLink";

export interface PullRequestPanelTarget {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}

function preferredEnvironmentFirst(
  projects: ReadonlyArray<EnvironmentProject>,
  preferredEnvironmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentProject> {
  const isPreferred = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId;
  return [...projects.filter(isPreferred), ...projects.filter((project) => !isPreferred(project))];
}

export function pickProjectForPullRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  { key }: Pick<TriagePullRequest, "key">,
  preferredEnvironmentId: EnvironmentId | null,
): PullRequestPanelTarget | null {
  const project = findProjectForChangeRequest(
    preferredEnvironmentFirst(projects, preferredEnvironmentId),
    key,
  );
  if (project === undefined) return null;
  return {
    environmentId: project.environmentId,
    reference: {
      projectId: project.id,
      host: key.host,
      repository: key.repository,
      number: key.number,
    },
  };
}
