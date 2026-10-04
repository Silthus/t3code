import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import { cacheLayer } from "./judgement.ts";
import * as TriageService from "./TriageService.ts";

export const forkTriageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "forkTriage",
  Effect.fnUntraced(function* (handlers) {
    const triage = yield* TriageService.TriageService;
    return handlers
      .handle(
        "assess",
        Effect.fn("environment.forkTriage.assess")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* triage.assess(args.payload);
        }),
      )
      .handle(
        "report",
        Effect.fn("environment.forkTriage.report")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* triage.report(
            args.payload,
            principal.scopes.has(AuthOrchestrationOperateScope) ? "operate" : "read",
          );
        }),
      );
  }),
).pipe(Layer.provide(TriageService.layer.pipe(Layer.provide(cacheLayer))));
