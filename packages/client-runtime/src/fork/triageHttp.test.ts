import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { TriageLoader, triageLoaderLayer, TriageUnsupportedError } from "./triageHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

function readReportAnswering(response: () => Response) {
  const fetchFn = (() => Promise.resolve(response())) satisfies typeof fetch;
  return TriageLoader.use((loader) => loader.report(PREPARED, { refresh: false })).pipe(
    Effect.provide(triageLoaderLayer.pipe(Layer.provide(remoteHttpClientLayer(fetchFn)))),
    Effect.flip,
  );
}

describe("TriageLoader", () => {
  it.effect("names the fork server when the environment has no triage endpoint", () =>
    Effect.gen(function* () {
      const error = yield* readReportAnswering(() => new Response("Not Found", { status: 404 }));

      expect(error).toBeInstanceOf(TriageUnsupportedError);
      expect(error.message).toBe(
        "Triage runs on the T3 Code fork server. This environment doesn't have it.",
      );
    }),
  );

  it.effect("keeps a rejected session as the environment's own error", () =>
    Effect.gen(function* () {
      const error = yield* readReportAnswering(() =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-auth-test",
          },
          { status: 401 },
        ),
      );

      expect(error._tag).toBe("EnvironmentAuthInvalidError");
    }),
  );
});
