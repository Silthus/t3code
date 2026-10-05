// @vitest-environment jsdom
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId, type TriagePullRequest } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

import { TriageNewThreadMenu } from "./TriageNewThreadMenu";

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  connectedIds: [] as EnvironmentId[],
  openDraft: vi.fn(),
  prepareCheckout: vi.fn(),
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useServerConfigs: () =>
    new Map(
      state.connectedIds.map((id) => [
        id,
        { environment: { capabilities: { pullRequests: true } } },
      ]),
    ),
}));
vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () => state.connectedIds,
  useEnvironments: () => ({
    environments: [
      { environmentId: "mac", label: "Mac" },
      { environmentId: "devbox", label: "Devbox" },
    ],
  }),
}));
vi.mock("./state", () => ({ useTriageEnvironmentId: () => "mac" }));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.openDraft }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: state.prepareCheckout }),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: () => "checkout", update: vi.fn() },
}));

function project(environmentId: string, id: string, repository: string): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      provider: "github",
      displayName: repository,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `git@github.com:${repository}.git`,
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

const selected = project("mac", "selected-A", "acme/other");
const matching = project("devbox", "matching-B", "acme/app");
const draftId = DraftId.make("selection-draft");
const threadId = ThreadId.make("selection-thread");
const pullRequest: TriagePullRequest = {
  key: { host: "github.com", repository: "acme/app", number: 42 },
  url: "https://github.com/acme/app/pull/42",
  title: "PR 42",
  isDraft: false,
  headSha: "abc123",
  baseRef: "main",
  headRef: "branch-42",
  updatedAt: "2026-10-01T10:00:00.000Z",
  lastPushAt: "2026-10-01T10:00:00.000Z",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  review: "none",
  ci: { state: "green", failing: [] },
  mergeable: "MERGEABLE",
  requestedReviewers: [],
  status: "ready-for-review",
  group: "needs-you",
  nextAction: "Ask for review",
  blockers: [],
  reasons: [],
  signals: [],
  openQuestions: [],
  refinement: "raw",
  counts: {
    humanThreadsAwaiting: 0,
    botFindingsOpen: 0,
    botFindingsResolved: 0,
    threadsTruncated: false,
  },
  judgement: { _tag: "not-requested" },
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  state.projects = [selected, matching];
  state.connectedIds = [selected.environmentId];
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  state.openDraft.mockReset().mockImplementation(async (projectRef, options) => {
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(projectRef, draftId, { threadId, ...options });
    return { draftId, threadId };
  });
  state.prepareCheckout.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "pr-42", worktreePath: "/work/pr-42", isOnPullRequestHead: true },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<TriageNewThreadMenu pullRequest={pullRequest} />));
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
}

async function selectCustomProject() {
  await render();
  await click(
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "New thread",
    ) ?? null,
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "Custom instruction",
    ) ?? null,
  );
  await click(document.querySelector('[role="combobox"]'));
  await click(
    [...document.querySelectorAll('[role="option"]')].find((item) =>
      item.textContent?.includes("selected-A"),
    ) ?? null,
  );
  const textarea = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Check accessibility.",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps the explicitly selected project displayed and prepares its draft when a matching environment reconnects", async () => {
  await selectCustomProject();
  state.connectedIds = [selected.environmentId, matching.environmentId];
  await render();
  expect(document.querySelector('[role="combobox"]')?.textContent).toBe("selected-A (Mac)");
  expect(document.body.textContent).not.toContain("No matching repository was found.");
  await click(
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open draft",
    ) ?? null,
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: EnvironmentId.make("mac"),
    projectId: ProjectId.make("selected-A"),
    environmentSelection: "manual",
    branch: "pr-42",
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Check accessibility.\n\nhttps://github.com/acme/app/pull/42",
  );
});

it("uses the current automatic match for a preset after cancelling an explicit selection", async () => {
  await selectCustomProject();
  state.connectedIds = [selected.environmentId, matching.environmentId];
  await render();
  await click(
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel") ??
      null,
  );
  await click(
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "New thread",
    ) ?? null,
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "Babysit",
    ) ?? null,
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: EnvironmentId.make("devbox"),
    projectId: ProjectId.make("matching-B"),
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "/babysit-pr https://github.com/acme/app/pull/42",
  );
});

it("keeps an unavailable explicit project visible and disables submission until it returns", async () => {
  await selectCustomProject();
  state.connectedIds = [matching.environmentId];
  await render();
  expect(document.querySelector('[role="combobox"]')?.textContent).toBe("selected-A (Mac)");
  expect(document.body.textContent).toContain(
    "The selected project is unavailable. Reconnect its environment or choose another project.",
  );
  const submit = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Open draft",
  )!;
  expect(submit.disabled).toBe(true);
  await click(submit);
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  state.connectedIds = [selected.environmentId, matching.environmentId];
  await render();
  await click(
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open draft",
    ) ?? null,
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: EnvironmentId.make("mac"),
    projectId: ProjectId.make("selected-A"),
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Check accessibility.\n\nhttps://github.com/acme/app/pull/42",
  );
});
