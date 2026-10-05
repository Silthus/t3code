import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { deriveLogicalProjectKey } from "~/logicalProject";

import { useStartTriageThread } from "./useStartTriageThread";

const { openDraft, prepareCheckout, toastUpdate } = vi.hoisted(() => ({
  openDraft: vi.fn(),
  prepareCheckout: vi.fn(),
  toastUpdate: vi.fn(),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => openDraft }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: prepareCheckout }),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: () => "checkout", update: toastUpdate },
}));

const environmentId = EnvironmentId.make("mac");
const projectId = ProjectId.make("app");
const draftId = DraftId.make("triage-draft");
const threadId = ThreadId.make("triage-thread");
const project: EnvironmentProject = {
  environmentId,
  id: projectId,
  title: "App",
  workspaceRoot: "/mac/app",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
};
const checkout = {
  _tag: "Success" as const,
  value: { branch: "fix-ci", worktreePath: "/mac/app/pr-42", isOnPullRequestHead: true },
};
let finishCheckout: (result: typeof checkout) => void;
let startedCheckout: Promise<void>;
let start: ReturnType<typeof useStartTriageThread>["start"];
let renderer: ReactTestRenderer;

function Harness({ target = project }: { target?: EnvironmentProject }) {
  const action = useStartTriageThread(target).start;
  useEffect(() => {
    start = action;
  }, [action]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toastUpdate.mockClear();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  openDraft.mockReset().mockImplementation(async (_projectRef, options) => {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId({ environmentId, projectId }, draftId, { threadId, ...options });
    return { draftId, threadId };
  });
  startedCheckout = new Promise((started) => {
    prepareCheckout.mockReset().mockImplementation(() => {
      started();
      return new Promise<typeof checkout>((resolve) => {
        finishCheckout = resolve;
      });
    });
  });
  act(() => {
    renderer = create(createElement(Harness));
  });
});
afterEach(() => {
  act(() => {
    renderer.unmount();
  });
  vi.unstubAllGlobals();
});

describe("starting a triage draft", () => {
  it("keeps one task when a grouped project on another environment starts during preparation", async () => {
    const local: EnvironmentProject = {
      ...project,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/app",
        provider: "github",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:acme/app.git",
        },
      },
    };
    const remote: EnvironmentProject = {
      ...local,
      environmentId: EnvironmentId.make("devbox"),
      id: ProjectId.make("remote-app"),
      workspaceRoot: "/devbox/app",
    };
    openDraft.mockImplementation(async (projectRef, options) => {
      const target = projectRef.environmentId === local.environmentId ? local : remote;
      useComposerDraftStore
        .getState()
        .setLogicalProjectDraftThreadId(deriveLogicalProjectKey(target), projectRef, draftId, {
          threadId,
          branch: null,
          worktreePath: null,
          envMode: "local",
          ...options,
        });
      return { draftId, threadId };
    });
    act(() => renderer.update(createElement(Harness, { target: local })));
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/other/pull/42", "Fix CI");
      await startedCheckout;
    });
    const finishFirstCheckout = finishCheckout;
    act(() => {
      renderer.unmount();
      renderer = create(createElement(Harness, { target: remote }));
    });
    prepareCheckout.mockImplementationOnce(async () => ({
      ...checkout,
      value: { ...checkout.value, branch: "qa", worktreePath: "/devbox/app/qa" },
    }));
    await act(async () => {
      await start("https://github.com/acme/other/pull/43", "QA swarm");
      finishFirstCheckout(checkout);
      await pending;
    });
    const store = useComposerDraftStore.getState();
    expect({
      draft: store.getDraftSession(draftId),
      prompt: store.getComposerDraft(draftId)?.prompt,
    }).toMatchObject({
      draft: { environmentId, projectId, branch: "fix-ci", worktreePath: "/mac/app/pr-42" },
      prompt: "Fix CI",
    });
  });
  it.each(["sent", "discarded"])(
    "reports an interrupted checkout when its draft was %s",
    async (action) => {
      let pending: Promise<void>;
      await act(async () => {
        pending = start("https://github.com/acme/app/pull/42", "Fix CI");
        await startedCheckout;
      });
      const store = useComposerDraftStore.getState();
      if (action === "sent") {
        store.markDraftThreadPromoting(draftId, { environmentId, threadId });
      } else {
        store.clearProjectDraftThreadById({ environmentId, projectId }, draftId);
      }
      await act(async () => {
        finishCheckout(checkout);
        await pending;
      });
      const description = toastUpdate.mock.lastCall?.[1].description;
      expect(description).toBe(
        "The draft was sent or discarded while preparing. Open a new draft to use the checkout.",
      );
    },
  );
  it("keeps the chosen environment manual while preparing its worktree", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await startedCheckout;
    });
    const duringPreparation = useComposerDraftStore.getState().getDraftSession(draftId);
    await act(async () => {
      finishCheckout(checkout);
      await pending;
    });
    expect(duringPreparation).toMatchObject({
      environmentId: EnvironmentId.make("mac"),
      projectId: ProjectId.make("app"),
      environmentSelection: "manual",
    });
  });

  it.each([
    { environmentId: EnvironmentId.make("devbox"), projectId: ProjectId.make("remote-app") },
    { environmentId, projectId },
  ])(
    "keeps a changed project or checkout when preparation finishes in $environmentId",
    async (changedProject) => {
      let pending: Promise<void>;
      await act(async () => {
        pending = start("https://github.com/acme/app/pull/42", "Fix CI");
        await startedCheckout;
      });
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        projectRef: changedProject,
        branch: "my-work",
        worktreePath: "/devbox/app/my-work",
      });
      await act(async () => {
        finishCheckout(checkout);
        await pending;
      });
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
        ...changedProject,
        branch: "my-work",
        worktreePath: "/devbox/app/my-work",
      });
    },
  );

  it("preserves the draft and typed text when checkout fails", async () => {
    prepareCheckout.mockImplementationOnce(async () => {
      useComposerDraftStore.getState().setPrompt(draftId, "Keep this scope small.");
      return { _tag: "Failure", cause: Cause.fail(new Error("Pull request checkout failed")) };
    });
    await act(async () => {
      await start("https://github.com/acme/app/pull/42", "Fix CI");
    });
    const store = useComposerDraftStore.getState();
    expect({
      draft: store.getDraftSession(draftId),
      prompt: store.getComposerDraft(draftId)?.prompt,
    }).toMatchObject({
      draft: {
        environmentId: EnvironmentId.make("mac"),
        projectId: ProjectId.make("app"),
        branch: null,
        worktreePath: null,
        promotedTo: null,
      },
      prompt: "Keep this scope small.\n\nFix CI",
    });
  });

  it("keeps one task and checkout when triage is reopened during preparation", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await startedCheckout;
    });
    const finishFirstCheckout = finishCheckout;
    act(() => {
      renderer.unmount();
      renderer = create(createElement(Harness));
    });
    prepareCheckout.mockImplementationOnce(async () => ({
      ...checkout,
      value: { ...checkout.value, branch: "qa", worktreePath: "/mac/app/qa" },
    }));
    await act(async () => {
      await start("https://github.com/acme/app/pull/43", "QA swarm");
      finishFirstCheckout(checkout);
      await pending;
    });
    const store = useComposerDraftStore.getState();
    expect({
      draft: store.getDraftSession(draftId),
      prompt: store.getComposerDraft(draftId)?.prompt,
    }).toMatchObject({
      draft: { branch: "fix-ci", worktreePath: "/mac/app/pr-42" },
      prompt: "Fix CI",
    });
  });
});
