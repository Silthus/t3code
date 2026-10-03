import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import type { ClaudeSettings } from "@t3tools/contracts";

import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { skillOverrideSettingsPaths } from "../Drivers/ClaudeSkills.ts";

const decodeSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      apiKeyHelper: Schema.optional(Schema.Unknown),
      forceLoginGatewayUrl: Schema.optional(Schema.Unknown),
      policyHelper: Schema.optional(Schema.Unknown),
      policyHelpers: Schema.optional(Schema.Unknown),
    }),
  ),
);

const resolveProxyEnvironment = Effect.fnUntraced(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly settings: ClaudeSettings;
  readonly cwd: string | null;
}) {
  const flags = parseCliArgs(input.settings.launchArgs).flags;
  if (
    ["settings", "setting-sources", "managed-settings", "bare"].some((flag) =>
      Object.hasOwn(flags, flag),
    )
  )
    return null;
  if (input.cwd === null) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeHomePath(input.settings, input.environment);
  const environment = { ...input.environment };
  const profileDir =
    environment.ANTHROPIC_CONFIG_DIR ??
    (environment.XDG_CONFIG_HOME
      ? path.join(environment.XDG_CONFIG_HOME, "anthropic")
      : path.join(environment.HOME ?? NodeOS.homedir(), ".config", "anthropic"));
  if (
    environment.ANTHROPIC_PROFILE ||
    environment.ANTHROPIC_CONFIG_DIR ||
    (yield* fileSystem.exists(path.join(profileDir, "active_config"))) ||
    (yield* fileSystem.exists(path.join(profileDir, "configs", "default.json")))
  )
    return null;
  const globalConfigPath = (yield* fileSystem.exists(path.join(configDir, ".config.json")))
    ? path.join(configDir, ".config.json")
    : input.settings.homePath.trim() || environment.CLAUDE_CONFIG_DIR
      ? path.join(configDir, ".claude.json")
      : path.join(NodeOS.homedir(), ".claude.json");
  if (yield* fileSystem.exists(globalConfigPath)) {
    const globalSettings = yield* fileSystem.readFileString(globalConfigPath).pipe(
      Effect.flatMap(decodeSettings),
      Effect.orElseSucceed(() => null),
    );
    if (
      globalSettings === null ||
      Object.keys(globalSettings.env ?? {}).some((key) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(key))
    )
      return null;
  }
  let repositoryRoot: string | undefined;
  let current = path.resolve(input.cwd);
  while (true) {
    if (yield* fileSystem.exists(path.join(current, ".git"))) {
      repositoryRoot = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const paths = skillOverrideSettingsPaths(
    path,
    configDir,
    input.cwd,
    yield* HostProcessPlatform,
    environment,
    repositoryRoot,
  );
  const managedPath = paths.at(-1);
  const fragmentsDir = managedPath?.endsWith("managed-settings.json")
    ? path.join(path.dirname(managedPath), "managed-settings.d")
    : undefined;
  const fragments =
    fragmentsDir && (yield* fileSystem.exists(fragmentsDir))
      ? (yield* fileSystem.readDirectory(fragmentsDir))
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => path.join(fragmentsDir, name))
      : [];
  for (const [index, settingsPath] of [...paths, ...fragments].entries()) {
    if (!(yield* fileSystem.exists(settingsPath))) continue;
    const settings = yield* fileSystem.readFileString(settingsPath).pipe(
      Effect.flatMap(decodeSettings),
      Effect.orElseSucceed(() => null),
    );
    if (
      settings === null ||
      settings.apiKeyHelper !== undefined ||
      settings.forceLoginGatewayUrl !== undefined ||
      settings.policyHelper !== undefined ||
      settings.policyHelpers !== undefined
    )
      return null;
    for (const [key, value] of Object.entries(settings.env ?? {})) {
      if ((key === "HOME" || key === "XDG_CONFIG_HOME") && environment[key] !== value) return null;
      if (
        !/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_.*FILE_DESCRIPTOR|CLAUDE_CODE_OAUTH_TOKEN|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|CLAUDE_CODE_CERT_STORE)/.test(
          key,
        )
      )
        continue;
      if (environment[key] !== undefined && environment[key] !== value) return null;
      if (index > 0 && environment[key] !== value) return null;
      environment[key] = value;
    }
  }
  if (
    Object.entries(environment).some(
      ([key, value]) =>
        value &&
        /^(CLAUDE_CODE_USE_|CLAUDE_CODE_.*FILE_DESCRIPTOR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_PROFILE|ANTHROPIC_CONFIG_DIR|ANTHROPIC_FEDERATION_RULE_ID|ANTHROPIC_ORGANIZATION_ID|ANTHROPIC_CUSTOM_HEADERS|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|CLAUDE_CODE_CERT_STORE)/.test(
          key,
        ),
    )
  )
    return null;
  return environment;
});

export const probeClaudeProxyLimitReset = Effect.fn("probeClaudeProxyLimitReset")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly model: string;
    readonly signal: AbortSignal;
    readonly settings: ClaudeSettings;
    readonly cwd: string | null;
  }) {
    const environment = yield* resolveProxyEnvironment(input).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (environment === null) return null;
    const baseUrl = environment.ANTHROPIC_BASE_URL;
    const token = environment.ANTHROPIC_AUTH_TOKEN;
    const key = environment.ANTHROPIC_API_KEY;
    if (!baseUrl || (!token && !key)) return null;
    const url = yield* Effect.try(() => new URL(baseUrl)).pipe(Effect.orElseSucceed(() => null));
    if (
      url === null ||
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname === "api.anthropic.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/messages/count_tokens`;
    const request = HttpClientRequest.post(url.toString()).pipe(
      HttpClientRequest.setHeaders({
        "anthropic-version": "2023-06-01",
        ...(token ? { authorization: `Bearer ${token}` } : { "x-api-key": key! }),
      }),
      HttpClientRequest.bodyJsonUnsafe({
        model: input.model,
        messages: [{ role: "user", content: "quota" }],
      }),
    );
    const probe = Effect.scoped(
      Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        const response = yield* client.execute(request);
        return { status: response.status, retryAfter: response.headers["retry-after"] };
      }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    );
    const canceled = Effect.callback<null>((resume) => {
      const abort = () => resume(Effect.succeed(null));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      return Effect.sync(() => input.signal.removeEventListener("abort", abort));
    });
    const response = yield* Effect.raceFirst(probe, canceled);
    if (response?.status !== 429 || !response.retryAfter) return null;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const value = response.retryAfter.trim();
    const delay = /^\d+$/.test(value);
    const date = delay ? Option.none() : DateTime.make(value);
    if (
      !delay &&
      (Option.isNone(date) ||
        DateTime.toDateUtc(date.value).toUTCString().toLowerCase() !== value.toLowerCase())
    )
      return null;
    const resetMs = delay
      ? now + Number(value) * 1_000
      : DateTime.toEpochMillis(Option.getOrThrow(date));
    if (!Number.isFinite(resetMs) || resetMs <= now || resetMs - now > 30 * 24 * 60 * 60 * 1_000)
      return null;
    return DateTime.formatIso(DateTime.makeUnsafe(resetMs));
  },
);
