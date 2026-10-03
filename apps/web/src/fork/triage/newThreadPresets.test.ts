import { describe, expect, it } from "vite-plus/test";

import { presetPrompt } from "./newThreadPresets";

const pullRequest = {
  url: "https://github.com/acme/app/pull/42",
  ci: { failing: ["Typecheck", "Unit tests"] },
};

describe("presetPrompt", () => {
  it("prefills the babysit skill with the pull request URL", () => {
    expect(presetPrompt("babysit", pullRequest)).toBe(
      "/babysit-pr https://github.com/acme/app/pull/42",
    );
  });

  it("asks the agent to address and reply to unresolved review comments", () => {
    expect(presetPrompt("review-comments", pullRequest)).toBe(
      "Address the unresolved review comments on https://github.com/acme/app/pull/42. Reply to each thread or fix the code, then push.",
    );
  });

  it("names the failing checks when asking for a CI fix", () => {
    expect(presetPrompt("fix-ci", pullRequest)).toBe(
      "Fix the failing CI on https://github.com/acme/app/pull/42: Typecheck, Unit tests. Push the fix.",
    );
  });

  it("asks for a CI fix without inventing checks when no failing names are available", () => {
    expect(presetPrompt("fix-ci", { ...pullRequest, ci: { failing: [] } })).toBe(
      "Fix the failing CI on https://github.com/acme/app/pull/42. Push the fix.",
    );
  });

  it("prefills the modernize skill for updating the branch and resolving conflicts", () => {
    expect(presetPrompt("modernize", pullRequest)).toBe(
      "/modernize-pr https://github.com/acme/app/pull/42",
    );
  });

  it("prefills the QA swarm skill with the pull request URL", () => {
    expect(presetPrompt("qa-swarm", pullRequest)).toBe(
      "/qa-swarm https://github.com/acme/app/pull/42",
    );
  });

  it("keeps the custom instruction and appends the pull request URL", () => {
    expect(presetPrompt("custom", pullRequest, "Check accessibility.\nKeep the scope small.")).toBe(
      "Check accessibility.\nKeep the scope small.\n\nhttps://github.com/acme/app/pull/42",
    );
  });
});
