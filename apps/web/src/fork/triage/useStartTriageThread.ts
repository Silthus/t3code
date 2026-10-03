import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { handoffPrompt, readableFailure } from "~/components/pullRequest/pullRequestDetail.logic";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";

const preparingProjects = new Set<string>();

export function useStartTriageThread(project: EnvironmentProject | null) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId: project?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
  });
  const [preparing, setPreparing] = useState(false);

  const start = async (url: string, prompt: string) => {
    if (project === null) return;
    const projectKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    if (preparingProjects.has(projectKey)) {
      toastManager.add({
        type: "warning",
        title: "A pull request draft is already preparing in this project",
      });
      return;
    }
    preparingProjects.add(projectKey);
    setPreparing(true);
    const toastId = toastManager.add({
      type: "loading",
      title: "Preparing the pull request checkout...",
    });
    let draftId: DraftId | null = null;
    try {
      const opened = await newThread(scopeProjectRef(project.environmentId, project.id), {
        branch: null,
        worktreePath: null,
        envMode: "local",
      });
      if (opened === null) throw new Error("Try again from the project, or open a draft first.");
      draftId = opened.draftId;
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(project.environmentId, project.id),
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      const prepared = await prepareThread.run({
        reference: url,
        mode: "worktree",
        threadId: opened.threadId,
      });
      if (prepared._tag === "Failure") throw squashAtomCommandFailure(prepared);
      const store = useComposerDraftStore.getState();
      const draft = store.getDraftSession(draftId);
      if (draft === null || draft.promotedTo !== null) {
        throw new Error(
          "The draft was sent or discarded while preparing. Open a new draft to use the checkout.",
        );
      }
      if (
        draft.environmentId !== project.environmentId ||
        draft.projectId !== project.id ||
        draft.branch !== null ||
        draft.worktreePath !== null ||
        draft.envMode !== "local" ||
        draft.environmentSelection !== "manual"
      ) {
        throw new Error(
          "The draft's project or checkout changed while preparing. Its current checkout was kept.",
        );
      }
      store.setDraftThreadContext(draftId, {
        branch: prepared.value.branch,
        worktreePath: prepared.value.worktreePath,
        envMode: prepared.value.worktreePath === null ? "local" : "worktree",
      });
      toastManager.update(toastId, {
        type: prepared.value.isOnPullRequestHead ? "success" : "warning",
        title: prepared.value.isOnPullRequestHead
          ? "Pull request draft ready"
          : "Checkout is behind the pull request",
        description: prepared.value.isOnPullRequestHead
          ? "The prompt is in the composer. Review it, then send."
          : "Local changes kept the checkout on older commits. Review the branch before sending.",
      });
    } catch (error) {
      const draft =
        draftId === null ? null : useComposerDraftStore.getState().getDraftSession(draftId);
      toastManager.update(toastId, {
        type: "error",
        title:
          draftId === null
            ? "Could not open a draft"
            : "Could not prepare the pull request checkout",
        description: [
          draft !== null && draft.promotedTo === null
            ? "Your draft and prompt are kept. Review its checkout before sending."
            : null,
          readableFailure(error, "Try again from the project's branch picker."),
        ]
          .filter(Boolean)
          .join(" "),
      });
    } finally {
      if (draftId !== null) {
        const store = useComposerDraftStore.getState();
        const draft = store.getDraftSession(draftId);
        if (draft !== null && draft.promotedTo === null) {
          store.setPrompt(
            draftId,
            handoffPrompt(
              {
                prompt: store.getComposerDraft(draftId)?.prompt ?? "",
                lastHandoffPrompt: undefined,
              },
              prompt,
            ),
          );
        }
      }
      preparingProjects.delete(projectKey);
      setPreparing(false);
    }
  };

  return { start, preparing };
}
