import { type TriageJudgementBasis, type TriagePullRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../../sourceControl/githubGraphQlBudget.ts";

const DIFF_BUDGET = 40_000;
const FILE_BUDGET = 8_000;
const LOW_SIGNAL =
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$|\.snap$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|__snapshots__)\//;
const TEST_FILE = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/;

export function excerptDiff(diff: string, testFiles: ReadonlyArray<string>) {
  if (diff.length <= DIFF_BUDGET) return { text: diff, basis: "full diff" as const, omitted: [] };
  const tests = new Set(testFiles);
  const sections = diff
    .split(/^(?=diff --git )/m)
    .filter((s) => s.startsWith("diff --git "))
    .map((text) => {
      const path = /^diff --git a\/.+? b\/(.+)$/m.exec(text)?.[1] ?? "";
      return { path, text, rank: LOW_SIGNAL.test(path) ? 2 : tests.has(path) ? 1 : 0 };
    })
    .sort((a, b) => a.rank - b.rank);
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of sections) {
    const cut =
      section.text.length > FILE_BUDGET
        ? `${section.text.slice(0, FILE_BUDGET)}\n[${section.text.slice(FILE_BUDGET).split("\n").length} more lines of this file cut]\n`
        : section.text;
    if (section.rank === 2 || used + cut.length > DIFF_BUDGET) {
      omitted.push(section.path);
      continue;
    }
    kept.push(cut);
    used += cut.length;
  }
  return { text: kept.join(""), basis: "diff excerpt" as const, omitted };
}

const PullRequestContext = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        body: Schema.String,
        headRefOid: Schema.String,
        files: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ path: Schema.String })) }),
      }),
    }),
  }),
});
const Request = Schema.Struct({
  query: Schema.String,
  variables: Schema.Struct({ owner: Schema.String, name: Schema.String, number: Schema.Int }),
});
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));
const Head = Schema.Struct({ headRefOid: Schema.String });
const decodeContext = Schema.decodeEffect(Schema.fromJsonString(PullRequestContext));
const decodeHead = Schema.decodeEffect(Schema.fromJsonString(Head));

export class BriefError extends Schema.TaggedError<BriefError>()("BriefError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

export const makeReadBrief = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  return Effect.fn("Triage.readBrief")(function* (pr: TriagePullRequest, cwd: string) {
    const [owner, name] = pr.key.repository.split("/");
    const query = yield* budget.query(
      pr.key.host,
      `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        body headRefOid files(first: 100) { nodes { path } }
      } }
    }`,
    );
    const output = yield* github.execute({
      cwd,
      args: ["api", "graphql", "--hostname", pr.key.host, "--input", "-"],
      stdin: encodeRequest({
        query,
        variables: { owner: owner!, name: name!, number: pr.key.number },
      }),
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (output.stdoutTruncated)
      return yield* new BriefError({ detail: "GitHub's PR context was too large to read." });
    yield* budget.observe(pr.key.host, output.stdout);
    const context = (yield* decodeContext(output.stdout)).data.repository.pullRequest;
    if (context.headRefOid !== pr.headSha)
      return yield* new BriefError({ detail: "The PR changed. Refresh before assessing it." });
    const diff = yield* github
      .execute({
        cwd,
        args: ["pr", "diff", String(pr.key.number), "--repo", pr.key.repository],
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.map((result) => (result.stdoutTruncated ? null : result.stdout)),
        Effect.orElseSucceed(() => null),
      );
    const head = yield* github.execute({
      cwd,
      args: [
        "pr",
        "view",
        String(pr.key.number),
        "--repo",
        pr.key.repository,
        "--json",
        "headRefOid",
      ],
    });
    if ((yield* decodeHead(head.stdout)).headRefOid !== pr.headSha) {
      return yield* new BriefError({
        detail: "The PR changed while reading its diff. Refresh before assessing it.",
      });
    }
    const files = context.files.nodes.map((file) => file.path);
    const testFiles = files.filter((path) => TEST_FILE.test(path));
    const excerpt = diff === null ? null : excerptDiff(diff, testFiles);
    const listed = files.length < pr.changedFiles ? ` (first ${files.length} listed)` : "";
    const lines = [
      `Repository: ${pr.key.repository}`,
      `Title: ${pr.title}`,
      `Description:\n${context.body.slice(0, 4_000) || "(empty)"}`,
      `Changed files: ${pr.changedFiles}, +${pr.additions} -${pr.deletions}${listed}\n${files.join("\n")}`,
      `Signals: CI ${pr.ci.state}; ${testFiles.length} test files changed; ${pr.additions + pr.deletions} changed lines`,
      excerpt
        ? `Diff${excerpt.omitted.length ? ` (excerpt; not shown: ${excerpt.omitted.join(", ")})` : ""}:\n${excerpt.text}`
        : "Diff: GitHub did not give a complete diff. Judge from the file list.",
    ];
    return { text: lines.join("\n\n"), basis: excerpt?.basis ?? "file list" } satisfies {
      text: string;
      basis: TriageJudgementBasis;
    };
  });
});
