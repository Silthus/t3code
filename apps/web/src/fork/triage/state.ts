import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import type { EnvironmentId, ForkTriageReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";

const REPORT_REFRESH_MS = 60_000;

class TriageConnectionError extends Data.TaggedError("TriageConnectionError")<{
  readonly message: string;
}> {}

export interface TriageEnvironmentReport {
  readonly environmentId: EnvironmentId;
  readonly report: ForkTriageReport | null;
  readonly error: string | null;
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : "This environment could not load triage.";

const reportHeaders = Effect.fn("forkTriage.reportHeaders")(function* (
  prepared: PreparedConnection,
  method: "GET" | "POST",
  pathname: string,
) {
  if (prepared.httpAuthorization === null) return {};
  if (prepared.httpAuthorization._tag === "Bearer") {
    return { authorization: `Bearer ${prepared.httpAuthorization.token}` };
  }
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const url = environmentEndpointUrl(prepared.httpBaseUrl, pathname);
  return {
    authorization: `DPoP ${prepared.httpAuthorization.accessToken}`,
    dpop: yield* signer.createProof({
      method,
      url,
      accessToken: prepared.httpAuthorization.accessToken,
    }),
  };
});

const loadReport = (environmentId: EnvironmentId) =>
  EnvironmentRegistry.pipe(
    Effect.flatMap((registry) =>
      registry.run(
        environmentId,
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.map(Option.flatten),
            Effect.timeoutOrElse({
              duration: 5000,
              orElse: () => Effect.succeed(Option.none<PreparedConnection>()),
            }),
          );
          if (Option.isNone(prepared)) {
            return yield* Effect.fail(
              new TriageConnectionError({ message: "This environment is not connected." }),
            );
          }
          const client = yield* makeEnvironmentHttpApiClient(prepared.value.httpBaseUrl);
          return yield* client.forkTriage
            .report({
              headers: yield* reportHeaders(prepared.value, "GET", "/api/fork/triage/report"),
            })
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                credentials: "include",
              }),
            );
        }),
      ),
    ),
  );

const refreshReport = (environmentId: EnvironmentId) =>
  EnvironmentRegistry.pipe(
    Effect.flatMap((registry) =>
      registry.run(
        environmentId,
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.map(Option.flatten),
            Effect.timeoutOrElse({
              duration: 5000,
              orElse: () => Effect.succeed(Option.none<PreparedConnection>()),
            }),
          );
          if (Option.isNone(prepared))
            return yield* Effect.fail(
              new TriageConnectionError({ message: "This environment is not connected." }),
            );
          const client = yield* makeEnvironmentHttpApiClient(prepared.value.httpBaseUrl);
          return yield* client.forkTriage
            .refresh({
              headers: yield* reportHeaders(prepared.value, "POST", "/api/fork/triage/refresh"),
            })
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                credentials: "include",
              }),
            );
        }),
      ),
    ),
  );

const refreshTriageCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "fork-triage.refresh",
  execute: (environmentIds: ReadonlyArray<EnvironmentId>) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        environmentIds,
        (id) => refreshReport(id).pipe(Effect.result),
        { concurrency: 2 },
      );
      if (results.some(Result.isFailure))
        return yield* Effect.fail(
          new TriageConnectionError({ message: "One or more environments rejected refresh." }),
        );
    }),
});

export const refreshTriageReports = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  refreshTriageCommand.run(appAtomRegistry, environmentIds);

const triageReportsAtom = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as Array<EnvironmentId>;
  const previous = new Map<EnvironmentId, ForkTriageReport>();
  return connectionAtomRuntime
    .atom(
      Effect.forEach(environmentIds, (environmentId) =>
        loadReport(environmentId).pipe(
          Effect.result,
          Effect.map((result): TriageEnvironmentReport => {
            if (Result.isSuccess(result)) {
              previous.set(environmentId, result.success);
              return { environmentId, report: result.success, error: null };
            }
            return {
              environmentId,
              report: previous.get(environmentId) ?? null,
              error: `${errorMessage(result.failure)} Previous evidence has not been refreshed.`,
            };
          }),
        ),
      ),
    )
    .pipe(Atom.withRefresh(REPORT_REFRESH_MS), Atom.withLabel(`fork-triage:${key}`));
});

export function useTriageReports(environmentIds: ReadonlyArray<EnvironmentId>) {
  const key = JSON.stringify([...environmentIds].sort());
  return triageReportsAtom(key);
}

export function readTriageReports(
  value: AsyncResult.AsyncResult<ReadonlyArray<TriageEnvironmentReport>, unknown>,
) {
  return value._tag === "Success" ? value.value : [];
}
