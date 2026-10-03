import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { handoffPrompt, readableFailure } from "~/components/pullRequest/pullRequestDetail.logic";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";

export function useStartTriageThread(project: EnvironmentProject | null) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId: project?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
  });
  const running = useRef(false);
  const [preparing, setPreparing] = useState(false);

  const start = async (url: string, prompt: string) => {
    if (project === null || running.current) return;
    running.current = true;
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
      toastManager.update(toastId, {
        type: "error",
        title:
          draftId === null
            ? "Could not open a draft"
            : "Could not prepare the pull request checkout",
        description: [
          draftId === null ? null : "Your draft and prompt are kept in the project.",
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
      running.current = false;
      setPreparing(false);
    }
  };

  return { start, preparing };
}
