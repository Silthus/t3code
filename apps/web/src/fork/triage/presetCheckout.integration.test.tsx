// @vitest-environment jsdom
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import GitActionsControl from "~/components/GitActionsControl";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { gitEnvironment } from "~/state/git";
import { vcsActionManager, vcsEnvironment } from "~/state/vcs";
import { useStartTriageThread } from "./useStartTriageThread";
import { deriveLogicalProjectKey } from "~/logicalProject";

const boundary = vi.hoisted(() => ({
  navigate: vi.fn(),
  checkout: vi.fn(),
  toastUpdate: vi.fn(),
  status: false,
  router: {
    state: { location: { href: "/triage" }, matches: [{ params: {} }] },
    navigate: (...args: unknown[]) => boundary.navigate(...args),
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => boundary.router,
  useParams: () => null,
  useNavigate: () => boundary.navigate,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("~/state/server", () => ({
  environmentServerConfigsAtom: Atom.make(
    new Map([["mac", { settings: DEFAULT_SERVER_SETTINGS }]]),
  ),
  serverEnvironment: { configValueAtom: () => Atom.make(null) },
}));
vi.mock("~/state/entities", () => ({
  readProjects: () => [project],
  readThreadShell: () => null,
  useThreadShell: () => null,
  useProjects: () => [project],
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === gitEnvironment.preparePullRequestThread
      ? boundary.checkout
      : async () => AsyncResult.success({}),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data: boundary.status
      ? {
          ...status,
          refName:
            query === vcsEnvironment.status({ environmentId, input: { cwd: "/mac/app/pr-42" } })
              ? "fix-ci"
              : "main",
        }
      : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: () => "checkout", update: boundary.toastUpdate },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogPanel: () => null,
  DialogPopup: () => null,
  DialogTitle: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: () => null,
  MenuItem: () => null,
  MenuItemLabel: () => null,
  MenuPopup: () => null,
  MenuSub: () => null,
  MenuSubTrigger: () => null,
  MenuSubPopup: () => null,
  MenuTrigger: () => null,
}));
vi.mock("~/components/chat/ThreadDetailsControl", () => ({ ThreadDetailsControl: () => null }));

const environmentId = EnvironmentId.make("mac");
const projectId = ProjectId.make("app");
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
const status = {
  isRepo: true,
  refName: "main",
  isDefaultRef: true,
  hasPrimaryRemote: true,
  hasWorkingTreeChanges: false,
  aheadCount: 0,
  behindCount: 0,
  workingTree: { files: [], added: 0, removed: 0 },
};
const prepared = AsyncResult.success({
  branch: "fix-ci",
  worktreePath: "/mac/app/pr-42",
  isOnPullRequestHead: true,
});
let start: ReturnType<typeof useStartTriageThread>["start"];
let renderer: ReactTestRenderer;
let draftId: DraftId | null;
let finishNavigation: () => void;
let navigationStarted: Promise<void>;
const checkoutFailure = () => AsyncResult.failure(Cause.fail(new Error("Checkout unavailable")));
type CheckoutResult = typeof prepared | ReturnType<typeof checkoutFailure>;
let finishCheckout: (result: CheckoutResult) => void;
let checkoutStarted: Promise<void>;

function Harness() {
  const action = useStartTriageThread(project).start;
  useEffect(() => {
    start = action;
  }, [action]);
  const draft = useComposerDraftStore((store) => (draftId ? store.getDraftSession(draftId) : null));
  return draft
    ? createElement(GitActionsControl, {
        draftId: currentDraftId(),
        activeThreadRef: scopeThreadRef(draft.environmentId, draft.threadId),
        gitCwd: draft.worktreePath ?? project.workspaceRoot,
        compact: true,
      })
    : null;
}
function currentDraftId() {
  if (draftId === null) throw new Error("No draft was opened");
  return draftId;
}
function render() {
  renderer.update(createElement(AppAtomRegistryProvider, null, createElement(Harness)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.status = false;
  boundary.toastUpdate.mockClear();
  boundary.router.state.location.href = "/triage";
  boundary.router.state.matches = [{ params: {} }];
  draftId = null;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  navigationStarted = new Promise((started) => {
    boundary.navigate.mockReset().mockImplementation((request) => {
      draftId = request.params.draftId;
      boundary.router.state.location.href = `/draft/${draftId}`;
      boundary.router.state.matches = [{ params: { draftId } }];
      started();
      return new Promise<void>((resolve) => {
        finishNavigation = resolve;
      });
    });
  });
  checkoutStarted = new Promise((started) => {
    boundary.checkout.mockReset().mockImplementation(() => {
      started();
      return new Promise<CheckoutResult>((resolve) => {
        finishCheckout = resolve;
      });
    });
  });
  act(() => {
    renderer = create(createElement(AppAtomRegistryProvider, null, createElement(Harness)));
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("preset checkout with live Git status", () => {
  it.each(["navigation", "preparation"])(
    "uses the prepared PR checkout when main hydrates during %s",
    async (timing) => {
      let pending: Promise<void>;
      await act(async () => {
        pending = start("https://github.com/acme/app/pull/42", "Fix CI");
        await navigationStarted;
      });
      if (timing === "preparation") {
        await act(async () => {
          finishNavigation();
          await checkoutStarted;
        });
      }
      await act(async () => {
        boundary.status = true;
        render();
      });
      if (timing === "navigation") {
        await act(async () => {
          finishNavigation();
          await checkoutStarted;
        });
      }
      await act(async () => {
        finishCheckout(prepared);
        await pending;
      });
      expect({
        draft: useComposerDraftStore.getState().getDraftSession(currentDraftId()),
        prompt: useComposerDraftStore.getState().getComposerDraft(currentDraftId())?.prompt,
        toast: boundary.toastUpdate.mock.lastCall?.[1].title,
      }).toMatchObject({
        draft: {
          branch: "fix-ci",
          worktreePath: "/mac/app/pr-42",
          envMode: "worktree",
          environmentSelection: "manual",
          promotedTo: null,
        },
        prompt: "Fix CI",
        toast: "Pull request draft ready",
      });
      expect(
        appAtomRegistry.get(
          vcsActionManager.stateAtom({ environmentId, cwd: project.workspaceRoot }),
        ).isRunning,
      ).toBe(false);
    },
  );
  it("releases failed preparation so the draft can hydrate and a retry can succeed", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await navigationStarted;
      finishNavigation();
      await checkoutStarted;
      boundary.status = true;
      useComposerDraftStore.getState().setPrompt(currentDraftId(), "Keep this small.");
      render();
    });
    await act(async () => {
      finishCheckout(checkoutFailure());
      await pending;
    });
    expect({
      draft: useComposerDraftStore.getState().getDraftSession(currentDraftId()),
      prompt: useComposerDraftStore.getState().getComposerDraft(currentDraftId())?.prompt,
      toast: boundary.toastUpdate.mock.lastCall?.[1],
    }).toMatchObject({
      draft: { branch: "main", envMode: "local", worktreePath: null, promotedTo: null },
      prompt: "Keep this small.\n\nFix CI",
      toast: {
        type: "error",
        description:
          "Your draft and prompt are kept. Review its checkout before sending. Checkout unavailable",
      },
    });
    boundary.checkout.mockImplementationOnce(async () => prepared);
    await act(async () => {
      const retry = start("https://github.com/acme/app/pull/42", "Fix CI");
      finishNavigation();
      await retry;
    });
    expect(useComposerDraftStore.getState().getDraftSession(currentDraftId())).toMatchObject({
      branch: "fix-ci",
      worktreePath: "/mac/app/pr-42",
      envMode: "worktree",
    });
  });

  it.each(["checkout", "project", "sent", "discarded"])(
    "keeps a genuine %s change during preparation",
    async (change) => {
      let pending: Promise<void>;
      await act(async () => {
        pending = start("https://github.com/acme/app/pull/42", "Fix CI");
        await navigationStarted;
        finishNavigation();
        await checkoutStarted;
      });
      const store = useComposerDraftStore.getState();
      const openedId = currentDraftId();
      await act(async () => {
        if (change === "checkout") {
          store.setDraftThreadContext(openedId, {
            branch: "my-work",
            worktreePath: "/mac/app/my-work",
            envMode: "worktree",
          });
        } else if (change === "project") {
          store.setDraftThreadContext(openedId, {
            projectRef: {
              environmentId: EnvironmentId.make("remote"),
              projectId: ProjectId.make("other"),
            },
          });
        } else if (change === "sent") {
          store.markDraftThreadPromoting(
            openedId,
            scopeThreadRef(environmentId, store.getDraftSession(openedId)!.threadId),
          );
        } else {
          store.clearProjectDraftThreadById({ environmentId, projectId }, openedId);
        }
        render();
      });
      const changed = store.getDraftSession(openedId);
      await act(async () => {
        finishCheckout(prepared);
        await pending;
      });
      expect(store.getDraftSession(openedId)).toEqual(changed);
      expect(boundary.toastUpdate.mock.lastCall?.[1].type).toBe("error");
      expect(store.getDraftSession(openedId)?.worktreePath).not.toBe("/mac/app/pr-42");
    },
  );

  it("keeps a project change made while navigation is pending", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await navigationStarted;
    });
    const openedId = currentDraftId();
    const changedProject = {
      environmentId: EnvironmentId.make("remote"),
      projectId: ProjectId.make("other"),
    };
    act(() =>
      useComposerDraftStore
        .getState()
        .setDraftThreadContext(openedId, { projectRef: changedProject }),
    );
    boundary.checkout.mockImplementationOnce(async () => prepared);
    await act(async () => {
      finishNavigation();
      await pending;
    });
    expect(useComposerDraftStore.getState().getDraftSession(openedId)).toMatchObject({
      ...changedProject,
      branch: null,
      worktreePath: null,
    });
    expect(boundary.toastUpdate.mock.lastCall?.[1].type).toBe("error");
  });
  it("does not apply a stale checkout or prompt to a replacement draft", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await navigationStarted;
      finishNavigation();
      await checkoutStarted;
    });
    const originalId = currentDraftId();
    const store = useComposerDraftStore.getState();
    const replacementId = DraftId.make("replacement");
    act(() => {
      store.clearProjectDraftThreadById({ environmentId, projectId }, originalId);
      store.setProjectDraftThreadId({ environmentId, projectId }, replacementId, {
        branch: "my-work",
        worktreePath: "/mac/app/my-work",
        envMode: "worktree",
      });
      store.setPrompt(replacementId, "My new task");
    });
    const replacement = store.getDraftSession(replacementId);
    await act(async () => {
      finishCheckout(prepared);
      await pending;
    });
    expect({
      draft: store.getDraftSession(replacementId),
      prompt: store.getComposerDraft(replacementId)?.prompt,
    }).toEqual({
      draft: replacement,
      prompt: "My new task",
    });
    expect(boundary.toastUpdate.mock.lastCall?.[1].type).toBe("error");
  });
  it.each(["fresh", "reused"])(
    "pins a %s draft environment before navigation exposes it to automatic routing",
    async (kind) => {
      if (kind === "reused") {
        useComposerDraftStore
          .getState()
          .setLogicalProjectDraftThreadId(
            deriveLogicalProjectKey(project),
            { environmentId, projectId },
            DraftId.make("empty-draft"),
            { environmentSelection: "auto", loadBalancedEnvironmentId: environmentId },
          );
      }
      let pending: Promise<void>;
      await act(async () => {
        pending = start("https://github.com/acme/app/pull/42", "Fix CI");
        await navigationStarted;
      });
      const duringNavigation = useComposerDraftStore.getState().getDraftSession(currentDraftId());
      await act(async () => {
        finishNavigation();
        await checkoutStarted;
        finishCheckout(prepared);
        await pending;
      });
      expect(duringNavigation).toMatchObject({
        environmentId,
        projectId,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      expect(boundary.toastUpdate.mock.lastCall?.[1].type).toBe("success");
    },
  );

  it("keeps automatic routing explicitly selected by the user during navigation", async () => {
    let pending: Promise<void>;
    await act(async () => {
      pending = start("https://github.com/acme/app/pull/42", "Fix CI");
      await navigationStarted;
    });
    act(() =>
      useComposerDraftStore.getState().setDraftThreadContext(currentDraftId(), {
        environmentSelection: "auto",
        loadBalancedEnvironmentId: null,
      }),
    );
    boundary.checkout.mockImplementationOnce(async () => prepared);
    await act(async () => {
      finishNavigation();
      await pending;
    });
    expect(useComposerDraftStore.getState().getDraftSession(currentDraftId())).toMatchObject({
      environmentSelection: "auto",
      worktreePath: null,
    });
    expect(boundary.toastUpdate.mock.lastCall?.[1].type).toBe("error");
  });
});
