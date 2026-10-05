import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  TextGenerationError,
  type TriageAssessInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
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
    changeDuringDiff?: boolean;
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
          if (options.changeDuringDiff)
            nodes = nodes.map((pr) => ({ ...pr, headRefOid: "changed-during-diff" }));
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
    const report = yield* triage.report({ refresh: false }, "operate");
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
      yield* triage.report({ refresh: false }, "operate");
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
      yield* triage.report({ refresh: false }, "operate");
      yield* triage.awaitJudgement(key(100));
    }).pipe(Effect.provide(first.layer));
    const restarted = harness({ store });
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      assert.strictEqual(
        (yield* triage.report({ refresh: false }, "operate")).pullRequests[0]!.judgement._tag,
        "ready",
      );
      assert.lengthOf(restarted.generated, 0);
      restarted.changeHead();
      assert.strictEqual(
        (yield* triage.report({ refresh: true }, "operate")).pullRequests[0]!.judgement._tag,
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
      yield* triage.report({ refresh: false }, "operate");
      yield* Deferred.await(twoStarted);
      assert.strictEqual(started, 2);
      const report = yield* triage.report({ refresh: false }, "operate");
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
    yield* triage.report({ refresh: false }, "operate");
    assert.strictEqual((yield* triage.awaitJudgement(key(100)))._tag, "failed");
    assert.strictEqual(
      (yield* triage.report({ refresh: false }, "operate")).pullRequests[0]!.judgement._tag,
      "failed",
    );
    yield* triage.report({ refresh: true }, "operate");
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
      yield* triage.report({ refresh: false }, "operate");
      assert.deepStrictEqual(yield* triage.awaitJudgement(key(100)), {
        _tag: "unavailable",
        reason: "Risk needs Claude or Codex as the text-generation model",
      });
      assert.strictEqual(
        (yield* triage.report({ refresh: false }, "operate")).pullRequests[1]!.judgement._tag,
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
    yield* triage.report({ refresh: false }, "operate");
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
      yield* triage.report({ refresh: false }, "operate");
      yield* triage.awaitJudgement(key(100));
      yield* triage.assess(key(103));
      yield* triage.awaitJudgement(key(103));
      const current = yield* triage.report({ refresh: true }, "operate");
      assert.strictEqual(current.pullRequests[1]!.judgement._tag, "failed");
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect(
  "read-only reports do not start jobs, and operate reports can assess the same cached facts",
  () => {
    const fake = harness();
    return Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      const read = yield* triage.report({ refresh: true }, "read");
      assert.strictEqual(read.pullRequests[0]!.judgement._tag, "not-requested");
      assert.lengthOf(fake.generated, 0);
      yield* triage.report({ refresh: false }, "operate");
      assert.strictEqual((yield* triage.awaitJudgement(key(100)))._tag, "ready");
      const cached = yield* triage.report({ refresh: true }, "read");
      assert.strictEqual(cached.pullRequests[0]!.judgement._tag, "ready");
      assert.lengthOf(fake.generated, 1);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect("retains a cached newer head when the old job completes during refresh", () =>
  Effect.gen(function* () {
    const memory = yield* KeyValueStore.KeyValueStore;
    const seeded = harness({ store: memory });
    seeded.changeHead();
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false }, "operate");
      yield* triage.awaitJudgement(key(100));
    }).pipe(Effect.provide(seeded.layer));
    let cachedId = "";
    const getStarted = yield* Deferred.make<void>();
    const releaseGet = yield* Deferred.make<void>();
    const releaseAnswer = yield* Deferred.make<void>();
    const answerDone = yield* Deferred.make<void>();
    const answerStarted = yield* Deferred.make<void>();
    let reads = 0;
    const store = KeyValueStore.make({
      ...memory,
      get: (key) =>
        Effect.gen(function* () {
          if (key.includes("#100/") && ++reads === 2) {
            cachedId = key;
            yield* Deferred.succeed(getStarted, undefined);
            yield* Deferred.await(releaseGet);
          }
          return yield* memory.get(key);
        }),
    });
    const fake = harness({
      store,
      answer: Effect.gen(function* () {
        yield* Deferred.succeed(answerStarted, undefined);
        yield* Deferred.await(releaseAnswer);
        yield* Deferred.succeed(answerDone, undefined);
        return verdict;
      }),
    });
    fake.setNodes(1);
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report({ refresh: false }, "operate");
      const oldReceipt = yield* triage
        .awaitJudgement(key(100))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(answerStarted);
      fake.changeHead();
      const refreshing = yield* triage
        .report({ refresh: true }, "operate")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(getStarted);
      const concurrent = yield* triage
        .report({ refresh: false }, "operate")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseAnswer, undefined);
      yield* Deferred.await(answerDone);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseGet, undefined);
      yield* Fiber.join(refreshing);
      yield* Fiber.join(oldReceipt);
      const report = yield* Fiber.join(concurrent);
      assert.strictEqual(report.pullRequests[0]!.judgement._tag, "ready");
      assert.strictEqual(report.pullRequests[0]!.headSha, "new-head");
      const persisted = decodeJson((yield* memory.get(cachedId))!) as { headSha: string };
      assert.strictEqual(persisted.headSha, "new-head");
    }).pipe(Effect.provide(fake.layer));
  }).pipe(Effect.provide(KeyValueStore.layerMemory)),
);

it.effect("refuses a diff that belongs to a head pushed during the read", () => {
  const fake = harness({ changeDuringDiff: true });
  return Effect.gen(function* () {
    const triage = yield* TriageService.TriageService;
    yield* triage.report({ refresh: false }, "operate");
    assert.deepStrictEqual(yield* triage.awaitJudgement(key(100)), {
      _tag: "failed",
      reason: "The PR changed while reading its diff. Refresh before assessing it.",
    });
    assert.lengthOf(fake.generated, 0);
  }).pipe(Effect.provide(fake.layer));
});

it.effect("keeps concurrent same-head profiles separate through completion and restart", () =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const started = yield* Deferred.make<void>();
    const releaseOld = yield* Deferred.make<void>();
    let calls = 0;
    const fake = harness({
      store,
      answer: Effect.gen(function* () {
        const call = ++calls;
        if (call === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(releaseOld);
        }
        return { ...verdict, summary: call === 1 ? "Old profile result" : "New profile result" };
      }),
    });
    const oldContext = {
      aboutMe: "I own synthetic widgets.",
      assessment: "Prioritize compatibility.",
    };
    const newContext = { aboutMe: "I maintain the demo.", assessment: "Prioritize retries." };
    const input = (context: typeof oldContext) => ({
      refresh: false,
      preferences: { global: context, repositories: {} },
    });
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      yield* triage.report(input(oldContext), "operate");
      yield* Deferred.await(started);
      const next = yield* triage.report(input(newContext), "operate");
      assert.strictEqual(next.pullRequests[0]!.judgement._tag, "pending");
      const fresh = yield* triage.awaitJudgement({ ...key(100), context: newContext });
      assert.strictEqual(fresh._tag, "ready");
      if (fresh._tag === "ready") assert.strictEqual(fresh.judgement.summary, "New profile result");
      yield* Deferred.succeed(releaseOld, undefined);
      const old = yield* triage.awaitJudgement({ ...key(100), context: oldContext });
      assert.strictEqual(old._tag, "ready");
      if (old._tag === "ready") assert.strictEqual(old.judgement.summary, "Old profile result");
      const current = yield* triage.report(input(newContext), "operate");
      assert.deepStrictEqual(current.pullRequests[0]!.judgement, fresh);
      assert.strictEqual(current.pullRequests[1]!.judgement._tag, "not-requested");
      assert.include(fake.generated[0]!, "I own synthetic widgets.");
      assert.notInclude(fake.generated[0]!, "Prioritize retries.");
    }).pipe(Effect.provide(fake.layer));
    const restarted = harness({ store });
    yield* Effect.gen(function* () {
      const triage = yield* TriageService.TriageService;
      const current = yield* triage.report(input(newContext), "operate");
      assert.strictEqual(current.pullRequests[0]!.judgement._tag, "ready");
      assert.lengthOf(restarted.generated, 0);
      const other = yield* triage.report({ refresh: false }, "read");
      assert.strictEqual(other.pullRequests[0]!.judgement._tag, "not-requested");
    }).pipe(Effect.provide(restarted.layer));
  }).pipe(Effect.provide(KeyValueStore.layerMemory)),
);

it.effect(
  "snapshots queued profile sections and does not invalidate risk for action-only edits",
  () =>
    Effect.gen(function* () {
      const twoStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      const fake = harness({
        answer: Effect.gen(function* () {
          if (++starts === 2) yield* Deferred.succeed(twoStarted, undefined);
          yield* Deferred.await(release);
          return verdict;
        }),
      });
      fake.setNodes(3);
      const context = {
        aboutMe: "I own the synthetic demo.",
        actions: { "fix-ci": "Run focused checks." },
      };
      const preferences = { global: context, repositories: {} };
      yield* Effect.gen(function* () {
        const triage = yield* TriageService.TriageService;
        yield* triage.report({ refresh: false, preferences }, "operate");
        yield* Deferred.await(twoStarted);
        context.aboutMe = "Changed after enqueue.";
        yield* Deferred.succeed(release, undefined);
        yield* triage.awaitJudgement({
          ...key(102),
          context: { aboutMe: "I own the synthetic demo." },
        });
        assert.include(fake.generated[2]!, "I own the synthetic demo.");
        assert.notInclude(fake.generated[2]!, "Changed after enqueue.");
        const current = yield* triage.report(
          {
            refresh: false,
            preferences: {
              global: {
                aboutMe: "I own the synthetic demo.",
                actions: { "fix-ci": "A different action." },
              },
              repositories: {},
            },
          },
          "operate",
        );
        assert.deepStrictEqual(
          current.pullRequests.map((pr) => pr.judgement._tag),
          ["ready", "ready", "ready"],
        );
        assert.lengthOf(fake.generated, 3);
      }).pipe(Effect.provide(fake.layer));
    }),
);
