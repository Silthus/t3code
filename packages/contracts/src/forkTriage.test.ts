import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ForkTriageReport } from "./forkTriage.ts";

const decodeReport = Schema.decodeSync(ForkTriageReport);

describe("ForkTriageReport", () => {
  it("accepts a report with actionable evidence and a linked thread", () => {
    const report = decodeReport({
      generatedAt: "2026-09-22T10:00:00.000Z",
      lastScanAt: "2026-09-22T09:59:00.000Z",
      items: [
        {
          repo: "posthog/posthog",
          number: 42,
          kind: "pull-request",
          title: "Keep snapshots current",
          url: "https://github.com/posthog/posthog/pull/42",
          lifecycle: "open",
          classification: "ready-maintainer",
          blockers: [
            {
              code: "approval",
              label: "Maintainer approval is required.",
              actor: "Maintainer",
              evidenceUrls: [],
            },
          ],
          nextActors: ["Maintainer"],
          evidence: [],
          lastSuccessfulRefresh: "2026-09-22T09:58:00.000Z",
          errors: [],
          certainty: "factual",
          relations: [],
          judgments: [],
        },
      ],
      changes: [],
      errors: [],
      usage: {
        githubRequests: 12,
        githubPages: 1,
        inferenceRequests: 0,
        inferenceCacheHits: 0,
        inferenceInputCharacters: 0,
        inferenceBudget: 100,
        inferenceBudgetRemaining: 100,
        truncatedConnections: 0,
      },
      configSummary: {
        scopes: ["posthog/posthog"],
        refreshIntervalMinutes: 15,
        staleAfterMinutes: 60,
        githubPageLimit: 2,
        inferenceEnabled: false,
        inferenceProvider: "vercel",
        inferenceModel: "typesafe-ai/jev",
        mergePolicies: [],
      },
    });

    expect(report.items[0]?.classification).toBe("ready-maintainer");
  });
});
