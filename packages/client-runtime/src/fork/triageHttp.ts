import type { TriageReport, TriageReportInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { EnvironmentHttpConnectionNotReadyError } from "../state/pullRequests.ts";

const TRIAGE_REPORT_TIMEOUT_MS = 60_000;

export class TriageUnsupportedError extends Data.TaggedError("TriageUnsupportedError")<{}> {
  override get message(): string {
    return "Triage runs on the T3 Code fork server. This environment doesn't have it.";
  }
}

export type TriageLoadError = RemoteEnvironmentRequestError | TriageUnsupportedError;

function isMissingRoute(error: RemoteEnvironmentRequestError): boolean {
  return error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && error.status === 404;
}

export class TriageLoader extends Context.Service<
  TriageLoader,
  {
    readonly report: (
      prepared: PreparedConnection,
      input: TriageReportInput,
    ) => Effect.Effect<TriageReport, TriageLoadError>;
  }
>()("@t3tools/client-runtime/fork/triageHttp/TriageLoader") {}

export const triageLoaderLayer: Layer.Layer<TriageLoader, never, HttpClient.HttpClient> =
  Layer.effect(
    TriageLoader,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      );
      return TriageLoader.of({
        report: (prepared, input) =>
          executeAuthenticatedEnvironmentHttpRequest({
            prepared,
            signer,
            remoteAuthorization,
            group: "forkTriage",
            method: "POST",
            url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).forkTriage.report(),
            timeoutMs: TRIAGE_REPORT_TIMEOUT_MS,
            request: ({ client, headers }) => client.report({ payload: input, headers }),
          }).pipe(
            Effect.mapError((error) =>
              isMissingRoute(error) ? new TriageUnsupportedError() : error,
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      });
    }),
  );

/** Reads the report from the environment the surrounding environment query runs in. */
export const loadTriageReport = Effect.fn("clientRuntime.fork.loadTriageReport")(function* (
  input: TriageReportInput,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const loader = yield* TriageLoader;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentHttpConnectionNotReadyError({
      message: "The environment HTTP connection is not ready.",
    });
  }
  return yield* loader.report(prepared.value, input);
});
