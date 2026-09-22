import { describe, expect, it } from "vite-plus/test";

import { filterTriageItems, groupTriageItems, toTriageMarkdown } from "./presentation.ts";

const item = {
  repo: "PostHog/posthog",
  number: 42,
  url: "https://github.com/PostHog/posthog/pull/42",
  title: "Keep snapshots current",
  kind: "pull-request" as const,
  lifecycle: "open" as const,
  classification: "blocked" as const,
  blockers: [
    {
      code: "checks",
      label: "Required checks are pending.",
      actor: "Author",
      evidenceUrls: [],
    },
  ],
  nextActors: ["Author"],
  evidence: [],
  lastSuccessfulRefresh: "2026-09-22T09:58:00.000Z",
  errors: [],
  certainty: "factual" as const,
  relations: [],
  judgments: [],
};

describe("triage presentation", () => {
  it("keeps a blocker discoverable through its text", () => {
    expect(filterTriageItems([item], { query: "pending", scope: null })).toEqual([item]);
  });

  it("copies a concise local markdown summary", () => {
    expect(toTriageMarkdown([item])).toContain(
      "- [PostHog/posthog#42](https://github.com/PostHog/posthog/pull/42) Keep snapshots current",
    );
  });

  it("copies the environment when reports include it", () => {
    expect(toTriageMarkdown([{ ...item, environmentLabel: "Work laptop" }])).toContain(
      "Environment: Work laptop.",
    );
  });

  it("groups terminal pull requests by their factual lifecycle", () => {
    const groups = groupTriageItems([
      { ...item, classification: "unknown" as const, lifecycle: "closed" as const },
      { ...item, number: 43, classification: "unknown" as const, lifecycle: "merged" as const },
      { ...item, classification: "issue" as const, kind: "issue" as const },
    ]);

    expect(groups.map((group) => group.classification)).toEqual(["closed", "merged", "issue"]);
  });

  it("keeps stale closures and verified replacements distinct from ordinary closures", () => {
    const groups = groupTriageItems([
      { ...item, lifecycle: "closed" as const, classification: "replaced" as const },
      {
        ...item,
        number: 43,
        lifecycle: "closed" as const,
        classification: "stale-closed" as const,
      },
    ]);
    expect(groups.map((group) => group.classification)).toEqual(["stale-closed", "replaced"]);
  });
});
