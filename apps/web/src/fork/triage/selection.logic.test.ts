import { describe, expect, it } from "vite-plus/test";

import { isSelectedPullRequest, parseTriageSearch } from "./selection.logic";

describe("parseTriageSearch", () => {
  it("keeps a selection with a repository and a positive whole number", () => {
    expect(parseTriageSearch({ repository: "acme/app", number: 42 })).toEqual({
      repository: "acme/app",
      number: 42,
    });
  });

  it.each([
    { name: "no repository", raw: { number: 42 } },
    { name: "an empty repository", raw: { repository: "", number: 42 } },
    { name: "no number", raw: { repository: "acme/app" } },
    { name: "a number given as text", raw: { repository: "acme/app", number: "42" } },
    { name: "a fractional number", raw: { repository: "acme/app", number: 4.2 } },
    { name: "zero", raw: { repository: "acme/app", number: 0 } },
    { name: "a negative number", raw: { repository: "acme/app", number: -1 } },
  ])("drops the selection when it has $name", ({ raw }) => {
    expect(parseTriageSearch(raw)).toEqual({});
  });
});

describe("isSelectedPullRequest", () => {
  const pullRequest = { key: { host: "github.com", repository: "Acme/App", number: 42 } };

  it("selects the pull request whose repository and number match, in any letter case", () => {
    expect(isSelectedPullRequest(pullRequest, { repository: "acme/app", number: 42 })).toBe(true);
  });

  it.each([
    { name: "another number", search: { repository: "acme/app", number: 43 } },
    { name: "another repository", search: { repository: "acme/site", number: 42 } },
    { name: "no selection", search: {} },
  ])("does not select it for $name", ({ search }) => {
    expect(isSelectedPullRequest(pullRequest, search)).toBe(false);
  });
});
