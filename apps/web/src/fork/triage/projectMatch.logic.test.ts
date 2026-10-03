import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickProjectForPullRequest } from "./projectMatch.logic";

const TRIAGE_ENVIRONMENT = EnvironmentId.make("mac");
const DEVBOX = EnvironmentId.make("devbox");

function project(environmentId: EnvironmentId, id: string, repository: string): EnvironmentProject {
  const [owner, name] = repository.split("/");
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/${repository}`,
      provider: "github",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `git@github.com:${repository}.git`,
      },
      ...(owner && name ? { owner, name } : {}),
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

const pullRequest = { key: { host: "github.com", repository: "acme/app", number: 42 } };

describe("pickProjectForPullRequest", () => {
  it("opens the pull request in the triage environment's project when several environments have the repository", () => {
    const projects = [
      project(DEVBOX, "devbox-app", "acme/app"),
      project(TRIAGE_ENVIRONMENT, "mac-app", "acme/app"),
    ];

    expect(pickProjectForPullRequest(projects, pullRequest, TRIAGE_ENVIRONMENT)).toEqual({
      environmentId: TRIAGE_ENVIRONMENT,
      reference: {
        projectId: ProjectId.make("mac-app"),
        host: "github.com",
        repository: "acme/app",
        number: 42,
      },
    });
  });

  it("falls back to another environment's project when the triage environment lacks the repository", () => {
    const projects = [
      project(TRIAGE_ENVIRONMENT, "mac-site", "acme/site"),
      project(DEVBOX, "devbox-app", "acme/app"),
    ];

    expect(pickProjectForPullRequest(projects, pullRequest, TRIAGE_ENVIRONMENT)).toEqual({
      environmentId: DEVBOX,
      reference: {
        projectId: ProjectId.make("devbox-app"),
        host: "github.com",
        repository: "acme/app",
        number: 42,
      },
    });
  });

  it("matches the repository regardless of letter case", () => {
    const projects = [project(DEVBOX, "devbox-app", "Acme/App")];

    expect(
      pickProjectForPullRequest(projects, pullRequest, TRIAGE_ENVIRONMENT)?.environmentId,
    ).toBe(DEVBOX);
  });

  it("finds no project when no environment has the repository", () => {
    const projects = [
      project(TRIAGE_ENVIRONMENT, "mac-site", "acme/site"),
      project(DEVBOX, "devbox-other", "other/app"),
    ];

    expect(pickProjectForPullRequest(projects, pullRequest, TRIAGE_ENVIRONMENT)).toBeNull();
  });
});
