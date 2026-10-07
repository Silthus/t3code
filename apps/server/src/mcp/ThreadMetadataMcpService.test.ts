import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMetadataMcpUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const decodeMetadataUpdate = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateInput);

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  requestNamespace: "provider-session:metadata-test",
  thread: {
    threadId,
    providerSessionId: "provider-session:metadata-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function layerService(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(layerService(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        layerService(() =>
          Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

const budgetDatabase = SqlitePersistence.layerMemory;
const budgetLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(budgetDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "metadata-budget" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: budgetDatabase, runEffectWorker: false },
  ),
);

it.effect("raises and disables a calling thread's context budget through metadata updates", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("metadata-budget:create"),
      threadId,
      projectId: ProjectId.make("project:metadata-budget"),
      title: "Budget recovery",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      contextBudgetTokens: 200_000,
      createdBy: "user",
      creationSource: "web",
    });
    const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService.pipe(
      Effect.provide(
        ThreadMetadataMcp.layer.pipe(
          Layer.provide(
            Layer.merge(NodeCrypto.layer, ThreadManagement.layer.pipe(Layer.provide(budgetLayer))),
          ),
        ),
      ),
    );
    for (const contextBudgetTokens of [300_000, null]) {
      const input = yield* decodeMetadataUpdate({
        action: "context_budget",
        contextBudgetTokens,
        clientRequestId: `metadata-budget:${contextBudgetTokens}`,
      });
      const result = yield* service.update(scope, input);
      expect(result.contextBudgetTokens).toBe(contextBudgetTokens);
      const persisted = yield* projections.getThreadProjection(threadId);
      expect(persisted.thread.contextBudgetTokens).toBe(contextBudgetTokens);
      expect(persisted.thread.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5" });
    }
  }).pipe(Effect.provide(budgetLayer)),
);

it("accepts budget changes only through the context_budget metadata action", () => {
  const decode = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);
  for (const contextBudgetTokens of [undefined, 0, -1, 1.5]) {
    expect(() => decode({ action: "context_budget", contextBudgetTokens })).toThrow();
  }
  for (const input of [
    { action: "rename", title: "Renamed" },
    { action: "regenerate_title" },
    {
      action: "link_pull_request",
      pullRequest: {
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
      },
    },
    { action: "unlink_pull_request" },
  ]) {
    expect(() => decode({ ...input, contextBudgetTokens: null })).toThrow();
  }
  expect(() =>
    decode({ action: "context_budget", contextBudgetTokens: null, title: "Renamed" }),
  ).toThrow();
});
