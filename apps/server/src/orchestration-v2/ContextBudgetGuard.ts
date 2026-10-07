import {
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type CommandId,
  type RunId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import { latestNativeContextUsage } from "./ContextHandoffBudget.ts";

export function currentContextUsage(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts" | "runs"
  >,
) {
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (providerThread === undefined) return null;
  const latest = latestNativeContextUsage(projection, providerThread);
  const usage = latest?.usage ?? providerThread.contextUsage;
  if (usage == null) return null;
  return {
    usage,
    providerThreadId: providerThread.id,
    nativeThreadId: providerThread.nativeThreadRef?.nativeId ?? null,
    reportedAt: latest?.reportedAt ?? null,
    source: latest === undefined ? ("provider_thread" as const) : ("provider_turn" as const),
  };
}

export function contextBudgetRequestEvents(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts" | "runs" | "runtimeRequests"
  >;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly commandId: CommandId;
  readonly now: DateTime.Utc;
}): Array<OrchestrationV2DomainEvent> | undefined {
  const budget = input.projection.thread.contextBudgetTokens;
  const context = currentContextUsage(input.projection);
  if (budget == null || context === null || context.usage.usedTokens < budget) return undefined;
  const pending = input.projection.runtimeRequests.find(
    (request) => request.id.startsWith("context-budget:") && request.status === "pending",
  );
  if (pending !== undefined)
    return [
      {
        id: EventId.make(`event:${input.commandId}:context-budget:pending`),
        threadId: input.projection.thread.id,
        occurredAt: input.now,
        type: "runtime-request.updated",
        payload: pending,
      },
    ];
  const threadId = input.projection.thread.id;
  const requestId = RuntimeRequestId.make(`context-budget:${input.commandId}`);
  const nodeId = NodeId.make(`context-budget:${input.commandId}`);
  const base = { threadId, occurredAt: input.now };
  return [
    {
      ...base,
      id: EventId.make(`event:${input.commandId}:context-budget:request`),
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: input.now,
        resolvedAt: null,
      },
    },
    {
      ...base,
      id: EventId.make(`event:${input.commandId}:context-budget:node`),
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: input.now,
        completedAt: null,
      },
    },
    {
      ...base,
      id: EventId.make(`event:${input.commandId}:context-budget:item`),
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`context-budget:${input.commandId}`),
        threadId,
        runId: input.runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: "waiting",
        title: "Context budget reached",
        startedAt: input.now,
        completedAt: null,
        updatedAt: input.now,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "context_handoff",
            header: "Handoff",
            required: true,
            allowCustomAnswer: true,
            question: `The provider reports ${context.usage.usedTokens} context tokens, reaching this thread's ${budget} token budget. New child dispatch is paused. Save a durable handoff with accepted tasks, decisions, pending child identities, review state and verified artifact paths. Summarize the handoff into a fresh continuation under the human's current model selection, or explicitly raise/disable the budget with t3_thread_update action context_budget. A refused dispatch is final for its clientRequestId; use a new clientRequestId after recovery. Existing work remains running and its durable state stays in this thread. How should work continue?`,
            options: [],
          },
        ],
      },
    },
  ];
}
