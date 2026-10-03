import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linkedThreadsByPullRequest, type LinkedThreadShell } from "./linkedThreads.logic";

const key = { host: "github.com", repository: "acme/app", number: 42 };
const supported = new Map([
  [EnvironmentId.make("mac"), { threadPullRequests: true, threadPullRequestBranchUnlink: true }],
  [EnvironmentId.make("devbox"), { threadPullRequests: true, threadPullRequestBranchUnlink: true }],
]);
const otherKey = { ...key, number: 7 };

function link(source: ThreadPullRequestLink["source"] = "manual"): ThreadPullRequestLink {
  return {
    ...key,
    url: "https://github.com/acme/app/pull/42",
    source,
    linkedAt: "2026-10-01T10:00:00.000Z",
    snapshot: null,
    stack: null,
  };
}

function shell(environment: string, id: string, updatedAt: string): LinkedThreadShell {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ThreadId.make(id),
    title: id,
    updatedAt,
    archivedAt: null,
    pullRequests: [link()],
    branchPullRequest: null,
  };
}

describe("linkedThreadsByPullRequest", () => {
  it("lists synced links from every environment newest first, including branch PRs once", () => {
    const older = shell("mac", "work", "2026-10-01T10:00:00.000Z");
    const newer = {
      ...shell("devbox", "work", "2026-10-02T10:00:00.000Z"),
      pullRequests: [{ ...link(), host: "GitHub.com", repository: "Acme/App" }],
      branchPullRequest: {
        projectId: ProjectId.make("app"),
        repository: "acme/app",
        number: 42,
        url: "https://github.com/acme/app/pull/42",
      },
    };
    const branchOnly = { ...newer, id: ThreadId.make("branch"), pullRequests: [] };
    const dismissed = {
      ...older,
      id: ThreadId.make("dismissed"),
      pullRequests: [link("stack-dismissed")],
    };

    const result = linkedThreadsByPullRequest(
      [older, newer, branchOnly, dismissed],
      [key, otherKey],
      supported,
    );

    expect(result.threadsByPullRequest.get("github.com/acme/app#42")).toEqual([
      {
        environmentId: EnvironmentId.make("devbox"),
        threadId: ThreadId.make("work"),
        title: "work",
        archivedAt: null,
      },
      {
        environmentId: EnvironmentId.make("devbox"),
        threadId: ThreadId.make("branch"),
        title: "work",
        archivedAt: null,
      },
      {
        environmentId: EnvironmentId.make("mac"),
        threadId: ThreadId.make("work"),
        title: "work",
        archivedAt: null,
      },
    ]);
    expect(result.threadsByPullRequest.get("github.com/acme/app#7")).toEqual([]);
  });
  it("does not restore a dismissed link through the matching branch fallback", () => {
    const dismissed = {
      ...shell("mac", "dismissed-branch", "2026-10-01T10:00:00.000Z"),
      pullRequests: [link("stack-dismissed")],
      branchPullRequest: {
        projectId: ProjectId.make("app"),
        repository: key.repository,
        number: key.number,
        url: link().url,
      },
    };
    expect(
      linkedThreadsByPullRequest([dismissed], [key], supported).threadsByPullRequest.get(
        "github.com/acme/app#42",
      ),
    ).toEqual([]);
  });

  it.each([{ threadPullRequestLinking: true }, { threadPullRequests: true }])(
    "keeps manual links usable and reports unmanageable branch links on %j",
    (capabilities) => {
      const manual = shell("legacy", "manual", "2026-10-01T10:00:00.000Z");
      const branch = {
        projectId: ProjectId.make("app"),
        repository: key.repository,
        number: otherKey.number,
        url: "https://github.com/acme/app/pull/7",
      };
      const branchOnly = {
        ...manual,
        id: ThreadId.make("branch"),
        pullRequests: [],
        branchPullRequest: branch,
      };
      const manualWithOtherBranch = { ...manual, branchPullRequest: branch };
      const result = linkedThreadsByPullRequest(
        [manualWithOtherBranch, branchOnly],
        [key, otherKey],
        new Map([[manual.environmentId, capabilities]]),
      );
      expect(
        result.threadsByPullRequest.get("github.com/acme/app#42")?.map((thread) => thread.threadId),
      ).toEqual(["manual"]);
      expect(result.threadsByPullRequest.get("github.com/acme/app#7")).toEqual([]);
      expect(result.upgradeEnvironmentsByPullRequest.get("github.com/acme/app#7")).toEqual([
        manual.environmentId,
      ]);
      expect(result.upgradeEnvironmentsByPullRequest.get("github.com/acme/app#42")).toBeUndefined();
    },
  );

  it("does not request an upgrade for true dismissed branches or explicitly linked branch PRs", () => {
    const manual = {
      ...shell("legacy", "manual", "2026-10-01T10:00:00.000Z"),
      branchPullRequest: {
        projectId: ProjectId.make("app"),
        repository: key.repository,
        number: key.number,
        url: link().url,
      },
    };
    const dismissed = {
      ...manual,
      id: ThreadId.make("dismissed"),
      pullRequests: [link("stack-dismissed")],
    };
    const result = linkedThreadsByPullRequest(
      [manual, dismissed],
      [key],
      new Map([[manual.environmentId, { threadPullRequests: true }]]),
    );
    expect(
      result.threadsByPullRequest.get("github.com/acme/app#42")?.map((thread) => thread.threadId),
    ).toEqual(["manual"]);
    expect(result.upgradeEnvironmentsByPullRequest.size).toBe(0);
  });

  it("keeps archived shell links, limits the index to requested PR identities and separates hosts", () => {
    const archived = {
      ...shell("mac", "archive", "2026-10-01T10:00:00.000Z"),
      archivedAt: "2026-10-02T10:00:00.000Z",
    };
    const otherHost = {
      ...shell("devbox", "enterprise", "2026-10-02T10:00:00.000Z"),
      pullRequests: [
        {
          ...link(),
          host: "github.example.com",
          url: "https://github.example.com/acme/app/pull/42",
        },
      ],
    };
    const result = linkedThreadsByPullRequest(
      [archived, otherHost],
      [{ ...key, repository: "Acme/App" }],
      supported,
    );
    expect([...result.threadsByPullRequest.entries()]).toEqual([
      [
        "github.com/acme/app#42",
        [
          {
            environmentId: EnvironmentId.make("mac"),
            threadId: ThreadId.make("archive"),
            title: "archive",
            archivedAt: "2026-10-02T10:00:00.000Z",
          },
        ],
      ],
    ]);
  });
});
