// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { expect, it } from "vite-plus/test";
import { forkTriageHttpApiLayer } from "./triage-http.ts";
import { createMonitor } from "./triage/monitor.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.forkTriage) {}

it("allows reading a snapshot but requires operate scope to refresh GitHub", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "triage-http-"));
  const monitor = createMonitor({ dataDir: directory });
  let scans = 0;
  const scopes = new Set<AuthEnvironmentScope>(["orchestration:read"]);
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("triage-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes,
      }),
    ),
  );
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(
      forkTriageHttpApiLayer({
        ...monitor,
        scan: async () => {
          scans++;
          return monitor.status();
        },
      }),
    ),
    Layer.provide(auth),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const handler = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const read = await handler.handler(new Request("http://localhost/api/fork/triage/report"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ items: [], lastScanAt: null });
    const forbidden = await handler.handler(
      new Request("http://localhost/api/fork/triage/refresh", { method: "POST" }),
    );
    expect(forbidden.status).toBe(403);
    expect(scans).toBe(0);
    scopes.add("orchestration:operate");
    const refreshed = await handler.handler(
      new Request("http://localhost/api/fork/triage/refresh", { method: "POST" }),
    );
    expect(refreshed.status).toBe(200);
    expect(scans).toBe(1);
  } finally {
    await handler.dispose();
    monitor.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
