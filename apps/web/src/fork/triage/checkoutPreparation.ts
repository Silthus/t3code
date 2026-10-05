import type { ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftThreadState } from "~/composerDraftStore";

const useCheckoutPreparations = create(() => ({ projects: new Map<string, ScopedProjectRef>() }));

export function claimCheckoutPreparation(projectKey: string, projectRef: ScopedProjectRef) {
  if (useCheckoutPreparations.getState().projects.has(projectKey)) return null;
  useCheckoutPreparations.setState(({ projects }) => ({
    projects: new Map(projects).set(projectKey, projectRef),
  }));
  return () => {
    useCheckoutPreparations.setState(({ projects }) => {
      const remaining = new Map(projects);
      remaining.delete(projectKey);
      return { projects: remaining };
    });
  };
}

function matchesPreparingProject(
  projects: ReadonlyMap<string, ScopedProjectRef>,
  draft: DraftThreadState | null,
) {
  if (draft === null) return false;
  const project = projects.get(draft.logicalProjectKey);
  return project?.environmentId === draft.environmentId && project.projectId === draft.projectId;
}

export function isCheckoutPreparing(draft: DraftThreadState | null) {
  return matchesPreparingProject(useCheckoutPreparations.getState().projects, draft);
}

export function useCheckoutPreparing(draft: DraftThreadState | null) {
  return useCheckoutPreparations(({ projects }) => matchesPreparingProject(projects, draft));
}
