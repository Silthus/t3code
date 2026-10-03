import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import * as TriageService from "./TriageService.ts";

export const forkTriageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "forkTriage",
  Effect.fnUntraced(function* (handlers) {
    const triage = yield* TriageService.TriageService;
    return handlers.handle(
      "report",
      Effect.fn("environment.forkTriage.report")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* triage.report(args.payload);
      }),
    );
  }),
).pipe(Layer.provide(TriageService.layer));
