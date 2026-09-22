// @effect-diagnostics nodeBuiltinImport:off
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as NodePath from "node:path";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type { TriageMonitor } from "./triage/types.ts";
import { createMonitor } from "./triage/monitor.ts";

class TriageMonitorScanError extends Data.TaggedError("TriageMonitorScanError")<{
  readonly cause: unknown;
}> {}

/** Attaches the monitor to the existing authenticated environment API. */
export const forkTriageHttpApiLayer = (monitor: TriageMonitor) =>
  HttpApiBuilder.group(EnvironmentHttpApi, "forkTriage", (handlers) =>
    Effect.succeed(
      handlers
        .handle(
          "report",
          Effect.fn("environment.forkTriage.report")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            return monitor.status();
          }),
        )
        .handle(
          "refresh",
          Effect.fn("environment.forkTriage.refresh")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            const report = yield* Effect.tryPromise({
              try: () => monitor.scan(),
              catch: (cause) => new TriageMonitorScanError({ cause }),
            }).pipe(
              Effect.catch((error) => failEnvironmentInternal("internal_error", error.cause)),
            );
            return { report };
          }),
        ),
    ),
  );

/** Owns the fork monitor and scheduler within this environment's server scope. */
export const forkTriageLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const configPath = yield* Config.String("T3CODE_TRIAGE_CONFIG").pipe(Config.option);
    const autoStart = yield* Config.Boolean("T3CODE_TRIAGE_AUTOSTART").pipe(
      Config.withDefault(false),
    );
    let pending: ReturnType<TriageMonitor["scan"]> | undefined;
    const monitor = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createMonitor({
          dataDir: NodePath.join(config.stateDir, "fork-triage"),
          ...(Option.isSome(configPath) ? { configPath: configPath.value } : {}),
        }),
      ),
      (resource) =>
        Effect.promise(async () => {
          await pending?.catch(() => undefined);
          resource.close();
        }),
    );
    const scopedMonitor: TriageMonitor = {
      ...monitor,
      scan: () => {
        if (pending) return pending;
        const task = monitor.scan();
        pending = task;
        return task.finally(() => {
          if (pending === task) pending = undefined;
        });
      },
    };
    if (autoStart) {
      const report = monitor.status();
      const interval = report.configSummary.refreshIntervalMinutes * 60_000;
      const now = yield* Clock.currentTimeMillis;
      const lastScan = report.lastScanAt === null ? NaN : Date.parse(report.lastScanAt);
      const initialDelay = Number.isFinite(lastScan) ? Math.max(0, interval - (now - lastScan)) : 0;
      yield* Effect.tryPromise({
        try: () => scopedMonitor.scan(),
        catch: (cause) => new TriageMonitorScanError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Fork triage scan failed.", { error: error.cause }),
        ),
        Effect.repeat(
          Schedule.spaced(Duration.minutes(monitor.status().configSummary.refreshIntervalMinutes)),
        ),
        Effect.delay(Duration.millis(initialDelay)),
        Effect.forkScoped,
      );
    }
    return forkTriageHttpApiLayer(scopedMonitor);
  }),
);
