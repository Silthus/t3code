import { expect, it } from "vite-plus/test";
import type { TriagePullRequest } from "@t3tools/contracts";
import { triageSummary, serializeTriageSlack } from "./slack.logic";

function pr(number = 1, overrides: Partial<TriagePullRequest> = {}): TriagePullRequest {
  return {
    key: { host: "github.com", repository: "acme/app", number },
    url: `https://github.com/acme/app/pull/${number}`,
    title: " Fix  widgets\n safely ",
    headSha: "head",
    judgement: { _tag: "not-requested" },
    pendingActions: [{ kind: "review", label: "Review the PR" }],
    status: "ready-for-review",
    updatedAt: "2026-10-05T00:00:00Z",
    ...overrides,
  } as TriagePullRequest;
}
const preferences = { global: {}, repositories: {} };
it("uses only current judged summaries and normalizes the deterministic title fallback", () => {
  const judgement = {
    risk: "low",
    riskReason: "Small",
    summary: " Makes  widgets\n safe ",
    basis: "full diff",
    headSha: "head",
    judgedAt: "2026-10-05T00:00:00Z",
  } as const;
  expect(triageSummary(pr())).toBe("Fix widgets safely");
  expect(triageSummary(pr(1, { judgement: { _tag: "ready", judgement } }))).toBe(
    "Makes widgets safe",
  );
  expect(
    triageSummary(
      pr(1, { judgement: { _tag: "ready", judgement: { ...judgement, headSha: "old" } } }),
    ),
  ).toBe("Fix widgets safely");
});
it("copies effective team actions even for mixed-owner PRs and skips pure waiting states", () => {
  const mixed = pr(1, {
    pendingActions: [
      { kind: "conflicts", label: "Resolve merge conflicts" },
      { kind: "review", label: "Review the PR" },
      { kind: "authorize-ci", label: "Authorize the CI run" },
    ],
  });
  expect(
    serializeTriageSlack(
      [mixed, pr(2, { pendingActions: [], waiting: ["Waiting for CI"] })],
      preferences,
    ).text,
  ).toBe(
    "[#1](https://github.com/acme/app/pull/1) Fix widgets safely. Please review the PR and authorize the CI run.",
  );
  expect(
    serializeTriageSlack([mixed], {
      global: { owners: { review: "author", "authorize-ci": "author" } },
      repositories: {},
    }).text,
  ).toBe("");
});
it("keeps ordering stable and escapes summaries, asks and URL attributes in rich clipboard HTML", () => {
  const hostile = pr(2, {
    title: '<script> & "widgets"',
    url: 'https://github.com/acme/app/pull/2?x="&y=1',
    pendingActions: [{ kind: "review", label: 'Review <widgets> & "details"' }],
  });
  const result = serializeTriageSlack([hostile, pr(1)], preferences);
  expect(result.text.split("\n")[0]).toMatch(/^\[#1\]/);
  expect(result.html).toContain("&lt;script&gt; &amp; &quot;widgets&quot;");
  expect(result.html).toContain("x=&quot;&amp;y=1");
  expect(result.html).not.toContain("<script>");
});
