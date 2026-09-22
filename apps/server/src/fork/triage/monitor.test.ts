// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, test } from "vite-plus/test";

import { createMonitor } from "./monitor.ts";
import type { JsonValue } from "./types.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

const temporaryDirectory = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-triage-"));
  temporaryDirectories.push(directory);
  return directory;
};

const jsonResponse = (value: JsonValue, headers?: Readonly<Record<string, string>>) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });

const githubFixture = (options?: {
  readonly comments?: () => ReadonlyArray<JsonValue>;
  readonly commentsHeaders?: Readonly<Record<string, string>>;
  readonly evaluate?: () => JsonValue;
  readonly reviewsUnavailable?: boolean;
  readonly children?: ReadonlyArray<JsonValue>;
}) => {
  const calls: Array<string> = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/graphql"))
      return jsonResponse({
        data: {
          repository: {
            viewerPermission: "WRITE",
            pullRequest: {
              baseRef: { branchProtectionRule: null },
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
              reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
              closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      });
    if (url.includes("/rules/branches/")) return jsonResponse([]);
    if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
    if (url.includes("/statuses")) return jsonResponse([]);
    if (url.endsWith("/issues/9"))
      return jsonResponse({
        number: 9,
        state: "closed",
        html_url: "https://github.com/acme/widgets/issues/9",
      });
    if (url.includes("/issues?")) {
      return jsonResponse([
        {
          number: 1,
          title: "Make retries bounded",
          html_url: "https://github.com/acme/widgets/pull/1",
          state: "open",
          updated_at: "2026-09-21T12:00:00Z",
          user: { login: "Silthus" },
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/1" },
        },
      ]);
    }
    if (url.endsWith("/issues/1")) {
      return jsonResponse({
        number: 1,
        title: "Make retries bounded",
        html_url: "https://github.com/acme/widgets/pull/1",
        state: "open",
        updated_at: "2026-09-21T12:00:00Z",
        body: "Fixes #9",
        user: { login: "Silthus" },
        pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/1" },
      });
    }
    if (url.endsWith("/pulls/1")) {
      return jsonResponse({
        number: 1,
        title: "Make retries bounded",
        html_url: "https://github.com/acme/widgets/pull/1",
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        updated_at: "2026-09-21T12:00:00Z",
        body: "Fixes #9",
        user: { login: "Silthus" },
        head: { sha: "abc" },
        base: { ref: "main" },
      });
    }
    if (url.includes("/commits/abc/check-runs")) {
      return jsonResponse({
        check_runs: [
          {
            id: 10,
            name: "test",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/widgets/actions/runs/10",
            completed_at: "2026-09-21T12:01:00Z",
          },
        ],
      });
    }
    if (url.includes("/pulls/1/reviews")) {
      if (options?.reviewsUnavailable) return new Response("forbidden", { status: 403 });
      return jsonResponse([
        {
          id: 20,
          state: "APPROVED",
          user: { login: "maintainer" },
          html_url: "https://github.com/acme/widgets/pull/1#pullrequestreview-20",
          submitted_at: "2026-09-21T12:02:00Z",
          commit_id: "abc",
          body: "Looks good",
        },
      ]);
    }
    if (url.includes("/issues/1/comments")) {
      return jsonResponse(options?.comments?.() ?? [], options?.commentsHeaders);
    }
    if (url.includes("/pulls/1/comments")) {
      return jsonResponse([]);
    }
    if (url.includes("/issues/1/timeline")) {
      return jsonResponse([]);
    }
    if (url.includes("/sub_issues")) {
      return jsonResponse(options?.children ?? []);
    }
    if (url.includes("/dependencies/")) {
      return jsonResponse([]);
    }
    if (url === "https://ai-gateway.vercel.sh/v1/evaluate") {
      return jsonResponse(
        options?.evaluate?.() ?? {
          answers: {
            nextActor: {
              type: "choice",
              choice: "maintainer",
              probabilities: { author: 0, reviewer: 0, maintainer: 1, none: 0 },
              confidence: 1,
            },
          },
        },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
};

test("scan exposes a factual ready item and persists it through the public API", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      mergePolicies: [
        {
          repo: "acme/widgets",
          requiredApprovals: 1,
          requiredChecks: ["test"],
          requireMergeable: true,
          maintainerActors: ["maintainer"],
        },
      ],
      inference: { enabled: true },
    }),
  );
  const fixture = githubFixture();
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: {},
      fetch: fixture.fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const report = await monitor.scan();

  NodeAssert.equal(report.items.length, 1);
  NodeAssert.equal(report.items[0]?.classification, "ready-maintainer");
  NodeAssert.equal(report.items[0]?.certainty, "factual");
  NodeAssert.equal(report.items[0]?.relations[0]?.source, "text-candidate");
  NodeAssert.equal(
    report.errors.some((error) => error.code === "inference-key-missing"),
    true,
  );
  NodeAssert.deepEqual(monitor.status().items, report.items);
  NodeAssert.equal(monitor.explain("acme/widgets#1").found, true);
  monitor.close();

  const reopened = createMonitor({ dataDir, configPath });
  NodeAssert.equal(reopened.status().items[0]?.number, 1);
  reopened.close();
});

test("unchanged scans reuse inference and a new discussion invalidates that cache", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      mergePolicies: [
        {
          repo: "acme/widgets",
          requiredApprovals: 1,
          requiredChecks: ["test"],
          requireMergeable: true,
        },
      ],
      inference: { enabled: true, requestBudget: 5 },
    }),
  );
  let comments: ReadonlyArray<JsonValue> = [];
  const fixture = githubFixture({ comments: () => comments });
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: { AI_GATEWAY_API_KEY: "secret" },
      fetch: fixture.fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  await monitor.scan();
  const unchanged = await monitor.scan();
  NodeAssert.equal(unchanged.changes.length, 0);
  NodeAssert.equal(unchanged.usage.inferenceRequests, 0);
  NodeAssert.equal(unchanged.usage.inferenceCacheHits, 1);

  comments = [
    {
      id: 31,
      html_url: "https://github.com/acme/widgets/pull/1#issuecomment-31",
      body: "Please document the retry ceiling.",
      user: { login: "maintainer" },
      updated_at: "2026-09-22T09:59:00Z",
    },
  ];
  const refreshed = await monitor.scan();
  NodeAssert.equal(refreshed.usage.inferenceRequests, 1);
  NodeAssert.equal(refreshed.usage.inferenceCacheHits, 0);
  monitor.close();
});

test("budget exhaustion remains visible instead of silently skipping inference", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", kinds: ["issue"] }],
      inference: { enabled: true, requestBudget: 1 },
    }),
  );
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/issues?")) {
      return jsonResponse(
        [1, 2].map((number) => ({
          number,
          title: `Issue ${number}`,
          html_url: `https://github.com/acme/widgets/issues/${number}`,
          state: "open",
          updated_at: "2026-09-21T12:00:00Z",
          body: "Needs triage",
          user: { login: "Silthus" },
        })),
      );
    }
    const itemMatch = url.match(/\/issues\/(\d+)$/);
    if (itemMatch) {
      const number = Number(itemMatch[1]);
      return jsonResponse({
        number,
        title: `Issue ${number}`,
        html_url: `https://github.com/acme/widgets/issues/${number}`,
        state: "open",
        updated_at: "2026-09-21T12:00:00Z",
        body: "Needs triage",
        user: { login: "Silthus" },
      });
    }
    if (
      url.includes("/comments") ||
      url.includes("/timeline") ||
      url.includes("/sub_issues") ||
      url.includes("/dependencies/")
    ) {
      return jsonResponse([]);
    }
    if (url === "https://ai-gateway.vercel.sh/v1/evaluate") {
      return jsonResponse({
        answers: {
          nextActor: {
            type: "choice",
            choice: "maintainer",
            probabilities: { maintainer: 1 },
            confidence: 1,
          },
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: { AI_GATEWAY_API_KEY: "secret" },
      fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const report = await monitor.scan();

  NodeAssert.equal(report.items.length, 2);
  NodeAssert.equal(report.usage.inferenceRequests, 1);
  NodeAssert.equal(
    report.errors.some((error) => error.code === "inference-budget-exhausted"),
    true,
  );
  monitor.close();
});

test("pagination limits prevent a readiness claim with discovered rules", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      githubPageLimit: 1,
      inference: { enabled: false },
    }),
  );
  const fixture = githubFixture({
    commentsHeaders: {
      link: '<https://api.github.com/repos/acme/widgets/issues/1/comments?page=2>; rel="next"',
    },
  });
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: {},
      fetch: fixture.fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const report = await monitor.scan();

  NodeAssert.equal(report.items[0]?.classification, "unknown");
  NodeAssert.deepEqual(
    report.items[0]?.blockers.map((blocker) => blocker.code),
    ["evidence-truncated"],
  );
  NodeAssert.equal(report.usage.truncatedConnections, 1);
  monitor.close();
});

test("inaccessible required evidence is unknown and keeps the available facts", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      mergePolicies: [
        {
          repo: "acme/widgets",
          requiredApprovals: 1,
          requiredChecks: ["test"],
          requireMergeable: true,
        },
      ],
      inference: { enabled: false },
    }),
  );
  const fixture = githubFixture({ reviewsUnavailable: true });
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: {},
      fetch: fixture.fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const report = await monitor.scan();

  NodeAssert.equal(report.items[0]?.classification, "unknown");
  NodeAssert.equal(
    report.items[0]?.blockers.some((blocker) => blocker.code === "evidence-unavailable"),
    true,
  );
  NodeAssert.equal(
    report.items[0]?.evidence.some((entry) => entry.sourceId === "item"),
    true,
  );
  monitor.close();
});

test("a durable lease rejects a concurrent scan of the same data directory", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      inference: { enabled: false },
    }),
  );
  const fixture = githubFixture();
  let releaseList: (() => void) | undefined;
  let reportListStarted: (() => void) | undefined;
  const listStarted = new Promise<void>((resolve) => {
    reportListStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).includes("/issues?")) {
      reportListStarted?.();
      await release;
    }
    return fixture.fetch(input, init);
  };
  const dependencies = {
    environment: {},
    fetch,
    getGitHubToken: async () => "test-token",
    now: () => new Date("2026-09-22T10:00:00Z"),
  };
  const first = createMonitor({ dataDir, configPath, dependencies });
  const second = createMonitor({ dataDir, configPath, dependencies });

  const running = first.scan();
  await listStarted;
  const rejected = await second.scan();
  NodeAssert.equal(
    rejected.errors.some((error) => error.code === "scan-lease-held"),
    true,
  );
  releaseList?.();
  await running;
  first.close();
  second.close();
});

test("a failed refresh preserves the last successful evidence as stale", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      inference: { enabled: false },
    }),
  );
  const fixture = githubFixture();
  let authenticated = true;
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: {},
      fetch: fixture.fetch,
      getGitHubToken: async () => {
        if (!authenticated) throw new Error("auth unavailable");
        return "test-token";
      },
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const fresh = await monitor.scan();
  authenticated = false;
  const stale = await monitor.scan();

  NodeAssert.equal(stale.items[0]?.certainty, "stale");
  NodeAssert.equal(stale.items[0]?.lastSuccessfulRefresh, fresh.items[0]?.lastSuccessfulRefresh);
  NodeAssert.equal(stale.items[0]?.evidence.length, fresh.items[0]?.evidence.length);
  monitor.close();
});

test("native issue relations remain distinct from text candidates", async () => {
  const dataDir = temporaryDirectory();
  const configPath = NodePath.join(dataDir, "triage.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      scopes: [{ repo: "acme/widgets", authors: ["Silthus"] }],
      inference: { enabled: false },
    }),
  );
  const fixture = githubFixture({
    children: [
      {
        number: 12,
        html_url: "https://github.com/acme/widgets/issues/12",
      },
    ],
  });
  const monitor = createMonitor({
    dataDir,
    configPath,
    dependencies: {
      environment: {},
      fetch: fixture.fetch,
      getGitHubToken: async () => "test-token",
      now: () => new Date("2026-09-22T10:00:00Z"),
    },
  });

  const report = await monitor.scan();
  const relations = report.items[0]?.relations ?? [];

  NodeAssert.equal(
    relations.some(
      (relation) =>
        relation.target === "acme/widgets#12" &&
        relation.kind === "child" &&
        relation.source === "github-native",
    ),
    true,
  );
  NodeAssert.equal(
    relations.some((relation) => relation.source === "text-candidate"),
    true,
  );
  monitor.close();
});
