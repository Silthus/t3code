import { EnvironmentId, ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linkedThreadsByPullRequest, type LinkedThreadShell } from "./linkedThreads.logic";

const key = { host: "github.com", repository: "acme/app", number: 42 };
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
    );

    expect(result.get("github.com/acme/app#42")).toEqual([
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
    expect(result.get("github.com/acme/app#7")).toEqual([]);
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
    expect(linkedThreadsByPullRequest([dismissed], [key]).get("github.com/acme/app#42")).toEqual(
      [],
    );
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
    );
    expect([...result.entries()]).toEqual([
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
