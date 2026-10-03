import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  TextGenerationError,
  type TriageAssessInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../../sourceControl/githubGraphQlBudget.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import recordedPage from "./fixtures/searchPage.json" with { type: "json" };
import * as TriageService from "./TriageService.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const key = (number: number): TriageAssessInput => ({
  host: "github.com",
  repository: "acme/app",
  number,
});
const verdict = {
  summary: "Keep refunds idempotent",
  risk: "medium",
  riskReason: "Refund retries touch billing; idempotency tests guard duplicate payments",
};
const [node] = recordedPage.data.search.nodes;

function harness(
  options: {
    missing?: boolean;
    store?: KeyValueStore.KeyValueStore;
    answer?: Effect.Effect<unknown, TextGenerationError>;
  } = {},
) {
  const generated: string[] = [];
  let nodes = [node!, { ...node!, number: 103, isDraft: true }];
  let diffFails = false;
  const requests: string[][] = [];
  const github = Layer.mock(GitHubCli.GitHubCli)({
    execute: ({ args, stdin }) =>
      Effect.suspend(() => {
        requests.push([...args]);
        let stdout: string;
        if (args[1] === "diff") {
          if (diffFails)
            return Effect.fail(
              new GitHubCli.GitHubCliCommandError({ command: "gh", cwd: "/", cause: undefined }),
            );
          stdout = "diff --git a/billing/refund.ts b/billing/refund.ts\n+guardRetries();\n";
        } else if (args[1] === "view") stdout = encodeJson({ headRefOid: nodes[0]!.headRefOid });
        else if (stdin?.includes("pullRequest(number:"))
          stdout = encodeJson({
            data: {
              repository: {
                pullRequest: {
                  body: "Prevents duplicate refunds.",
                  headRefOid: nodes[0]!.headRefOid,
                  files: { nodes: [{ path: "billing/refund.ts" }] },
                },
              },
            },
          });
        else
          stdout = encodeJson({
            data: {
              ...recordedPage.data,
              search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
            },
          });
        return Effect.succeed({
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: ChildProcessSpawner.ExitCode(0),
        });
      }),
  });
  const generation = Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      ...(options.missing
        ? {}
        : {
            generateJudgement: <A>(input: TextGeneration.JudgementGenerationInput<A>) =>
              Effect.gen(function* () {
                generated.push(input.prompt);
                assert.strictEqual(input.cwd, "/isolated/fork-triage/judge");
                assert.deepStrictEqual(
                  input.modelSelection,
                  DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
                );
                return yield* Schema.decodeUnknownEffect(input.outputSchema)(
                  yield* options.answer ?? Effect.succeed(verdict),
                ).pipe(
                  Effect.mapError(
                    () =>
                      new TextGenerationError({
                        operation: "generateJudgement",
                        detail: "Invalid judgement",
                      }),
                  ),
                );
              }),
          }),
    }),
  );
  const external = Layer.mergeAll(
    github,
    GitHubGraphQlBudget.layer,
    generation,
    Layer.effect(
      ServerConfig.ServerConfig,
      ServerConfig.ServerConfig.use((config) =>
        Effect.succeed({ ...config, stateDir: "/isolated" }),
      ),
    ).pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), "/isolated").pipe(
          Layer.provide(
            Layer.merge(FileSystem.layerNoop({ makeDirectory: () => Effect.void }), Path.layer),
          ),
        ),
      ),
    ),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    FileSystem.layerNoop({ makeDirectory: () => Effect.void }),
    options.store
      ? Layer.succeed(KeyValueStore.KeyValueStore, options.store)
      : KeyValueStore.layerMemory,
  );
  return {
    layer: TriageService.layer.pipe(Layer.provide(external)),
    generated,
    requests,
    changeHead: () => {
      nodes = nodes.map((pr) => ({ ...pr, headRefOid: "new-head" }));
    },
    setNodes: (count: number) => {
      nodes = Array.from({ length: count }, (_, i) => ({ ...node!, number: 100 + i }));
    },
    failDiff: () => {
      diffFails = true;
    },
  };
}

it.effect("automatically assesses non-drafts and leaves drafts for an explicit request", () => {
  const fake = harness();
  return Effect.gen(function* () {
    const triage = yield* TriageService.TriageService;
    const report = yield* triage.report({ refresh: false });
    assert.strictEqual(report.pullRequests[0]!.judgement._tag, "pending");
    assert.strictEqual(report.pullRequests[1]!.judgement._tag, "not-requested");
    const state = yield* triage.awaitJudgement(key(100));
    assert.strictEqual(state._tag, "ready", encodeJson(state));
    if (state._tag === "ready") assert.strictEqual(state.judgement.summary, verdict.summary);
    assert.lengthOf(fake.generated, 1);
    assert.include(fake.generated[0]!, "Description:\nPrevents duplicate refunds.");
    assert.include(fake.generated[0]!, "+guardRetries();");
  }).pipe(Effect.provide(fake.layer));
});

it.effect(
  "manually assesses drafts, deduplicates pending requests, and re-assesses a ready head",
  () => {
    const fake = harness();
    return Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false });
      yield* triage.awaitJudgement(key(100));
      assert.strictEqual((yield* triage.assess(key(103)))._tag, "pending");
      yield* triage.assess(key(103));
      assert.strictEqual((yield* triage.awaitJudgement(key(103)))._tag, "ready");
      assert.lengthOf(fake.generated, 2);
      assert.strictEqual((yield* triage.assess(key(103)))._tag, "pending");
      yield* triage.awaitJudgement(key(103));
      assert.lengthOf(fake.generated, 3);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect("reuses a persisted current head across service restarts and assesses a new head", () =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const first = harness({ store });
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false });
      yield* triage.awaitJudgement(key(100));
    }).pipe(Effect.provide(first.layer));
    const restarted = harness({ store });
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      assert.strictEqual(
        (yield* triage.report({ refresh: false })).pullRequests[0]!.judgement._tag,
        "ready",
      );
      assert.lengthOf(restarted.generated, 0);
      restarted.changeHead();
      assert.strictEqual(
        (yield* triage.report({ refresh: true })).pullRequests[0]!.judgement._tag,
        "pending",
      );
      const state = yield* triage.awaitJudgement(key(100));
      assert.strictEqual(state._tag, "ready");
      if (state._tag === "ready") assert.strictEqual(state.judgement.headSha, "new-head");
      assert.lengthOf(restarted.generated, 1);
    }).pipe(Effect.provide(restarted.layer));
  }).pipe(Effect.provide(KeyValueStore.layerMemory)),
);

it.effect("runs only two jobs while the remaining PRs stay pending", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const twoStarted = yield* Deferred.make<void>();
    let started = 0;
    const fake = harness({
      answer: Effect.gen(function* () {
        started++;
        if (started === 2) yield* Deferred.succeed(twoStarted, undefined);
        yield* Deferred.await(release);
        return verdict;
      }),
    });
    fake.setNodes(4);
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false });
      yield* Deferred.await(twoStarted);
      assert.strictEqual(started, 2);
      const report = yield* triage.report({ refresh: false });
      assert.deepStrictEqual(
        report.pullRequests.map((pr) => pr.judgement._tag),
        ["pending", "pending", "pending", "pending"],
      );
      yield* Deferred.succeed(release, undefined);
      const states = yield* Effect.forEach([100, 101, 102, 103], (n) =>
        triage.awaitJudgement(key(n)),
      );
      assert.deepStrictEqual(
        states.map((state) => state._tag),
        ["ready", "ready", "ready", "ready"],
      );
    }).pipe(Effect.provide(fake.layer));
  }),
);

it.effect("keeps a failure visible during cached reads and retries on the next GitHub read", () => {
  let attempts = 0;
  const fake = harness({
    answer: Effect.suspend(() =>
      ++attempts === 1
        ? Effect.fail(
            new TextGenerationError({
              operation: "generateJudgement",
              detail: "Provider is offline",
            }),
          )
        : Effect.succeed(verdict),
    ),
  });
  return Effect.gen(function* () {
    const triage = yield* TriageService.TriageService;
    yield* triage.report({ refresh: false });
    assert.strictEqual((yield* triage.awaitJudgement(key(100)))._tag, "failed");
    assert.strictEqual(
      (yield* triage.report({ refresh: false })).pullRequests[0]!.judgement._tag,
      "failed",
    );
    yield* triage.report({ refresh: true });
    assert.strictEqual((yield* triage.awaitJudgement(key(100)))._tag, "ready");
  }).pipe(Effect.provide(fake.layer));
});

it.effect.each([true, false])(
  "marks unsupported generation as unavailable, missing method: %s",
  (missing) => {
    const fake = harness({
      missing,
      answer: Effect.fail(
        new TextGenerationError({
          operation: "generateJudgement",
          detail: "Provider instance cannot generate judgements.",
        }),
      ),
    });
    return Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false });
      assert.deepStrictEqual(yield* triage.awaitJudgement(key(100)), {
        _tag: "unavailable",
        reason: "Risk needs Claude or Codex as the text-generation model",
      });
      assert.strictEqual(
        (yield* triage.report({ refresh: false })).pullRequests[1]!.judgement._tag,
        "not-requested",
      );
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect("falls back to the file list when GitHub cannot return the diff", () => {
  const fake = harness();
  fake.failDiff();
  return Effect.gen(function* () {
    const triage = yield* TriageService.TriageService;
    yield* triage.report({ refresh: false });
    const state = yield* triage.awaitJudgement(key(100));
    assert.strictEqual(state._tag, "ready");
    if (state._tag === "ready") assert.strictEqual(state.judgement.basis, "file list");
    assert.include(fake.generated[0]!, "Judge from the file list.");
  }).pipe(Effect.provide(fake.layer));
});

it.effect(
  "keeps a manually assessed draft failure visible after refresh without auto-assessing it",
  () => {
    const fake = harness({
      answer: Effect.fail(
        new TextGenerationError({ operation: "generateJudgement", detail: "Provider is offline" }),
      ),
    });
    return Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false });
      yield* triage.awaitJudgement(key(100));
      yield* triage.assess(key(103));
      yield* triage.awaitJudgement(key(103));
      const current = yield* triage.report({ refresh: true });
      assert.strictEqual(current.pullRequests[1]!.judgement._tag, "failed");
    }).pipe(Effect.provide(fake.layer));
  },
);
