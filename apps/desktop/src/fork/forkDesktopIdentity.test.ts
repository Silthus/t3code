import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterEach, vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUserData from "../app/DesktopUserData.ts";
import { forkDesktopIdentityDefine, resolveDesktopIdentity } from "./forkDesktopIdentity.ts";

const packagedMacInput = {
  dirname: "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.44",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>,
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({ ...packagedMacInput, ...overrides }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePathLayer.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>,
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("fork desktop identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("only the exact build value fork selects the fork identity", () => {
    assert.equal(resolveDesktopIdentity("fork"), "fork");
    assert.equal(resolveDesktopIdentity(" fork "), "fork");
    assert.equal(resolveDesktopIdentity(undefined), "upstream");
    assert.equal(resolveDesktopIdentity(""), "upstream");
    assert.equal(resolveDesktopIdentity("Fork"), "upstream");
  });

  it("bakes the identity from the build process environment", () => {
    assert.deepStrictEqual(forkDesktopIdentityDefine({ T3CODE_DESKTOP_IDENTITY: "fork" }), {
      __T3CODE_BUILD_DESKTOP_IDENTITY__: '"fork"',
    });
    assert.deepStrictEqual(forkDesktopIdentityDefine({}), {
      __T3CODE_BUILD_DESKTOP_IDENTITY__: '"upstream"',
    });
  });

  it.each([
    ["fork", '"fork"'],
    ["", '"upstream"'],
  ])("bakes T3CODE_DESKTOP_IDENTITY=%j into the main process bundle", async (value, baked) => {
    vi.stubEnv("T3CODE_DESKTOP_IDENTITY", value);
    vi.resetModules();
    const { default: desktopViteConfig } = await import("../../vite.config.ts");
    const mainEntry = [desktopViteConfig.pack ?? []]
      .flat()
      .find((entry) => [entry.entry].flat().includes("src/main.ts"));

    assert.equal(mainEntry?.define?.__T3CODE_BUILD_DESKTOP_IDENTITY__, baked);
  });

  it.effect.each([
    ["fork", "T3 Code (Fork)", "/Users/alice/.t3-fork"],
    [undefined, "T3 Code (Alpha)", "/Users/alice/.t3"],
  ] as const)(
    "resolves a build baked with %j at runtime",
    ([bakedIdentity, displayName, baseDir]) =>
      Effect.gen(function* () {
        vi.stubGlobal("__T3CODE_BUILD_DESKTOP_IDENTITY__", bakedIdentity);
        vi.resetModules();
        const baked = yield* Effect.promise(() => import("../app/DesktopEnvironment.ts"));
        const environment = yield* baked.DesktopEnvironment.pipe(
          Effect.provide(
            baked
              .layer(packagedMacInput)
              .pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    NodePathLayer.layerPosix,
                    DesktopConfig.layerTest({}),
                  ),
                ),
              ),
          ),
        );

        assert.equal(environment.displayName, displayName);
        assert.equal(environment.baseDir, baseDir);
      }),
  );

  it.effect("keeps the upstream identity when the build has no identity switch", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({});

      assert.equal(environment.displayName, "T3 Code (Alpha)");
      assert.equal(environment.branding.displayName, "T3 Code (Alpha)");
      assert.equal(environment.baseDir, "/Users/alice/.t3");
      assert.equal(environment.stateDir, "/Users/alice/.t3/userdata");
      assert.equal(environment.appUserModelId, "com.t3tools.t3code");
    }),
  );

  it.effect("gives a fork build its own name, user data, and T3 home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ desktopIdentity: "fork" });

      assert.equal(environment.displayName, "T3 Code (Fork)");
      assert.equal(environment.branding.displayName, "T3 Code (Fork)");
      assert.equal(environment.baseDir, "/Users/alice/.t3-fork");
      assert.equal(environment.stateDir, "/Users/alice/.t3-fork/userdata");
      assert.equal(
        environment.desktopSettingsPath,
        "/Users/alice/.t3-fork/userdata/desktop-settings.json",
      );
    }),
  );

  it.effect("keeps the upstream version so remote servers download matching releases", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ desktopIdentity: "fork" });

      assert.equal(environment.appVersion, "0.0.44");
    }),
  );

  it.effect("lets T3CODE_HOME override the fork's default home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { desktopIdentity: "fork" },
        { T3CODE_HOME: "/tmp/fork-home" },
      );

      assert.equal(environment.baseDir, "/tmp/fork-home");
      assert.equal(environment.stateDir, "/tmp/fork-home/userdata");
    }),
  );

  it.effect("keeps the upstream development identity for development runs of a fork build", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { desktopIdentity: "fork", isPackaged: false },
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );

      assert.equal(environment.displayName, "T3 Code (Dev)");
      assert.equal(environment.baseDir, "/Users/alice/.t3");
    }),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "scopes the single-instance lock away from an installed official app on %s",
    (platform) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-fork-identity-",
        });
        const environmentFor = (desktopIdentity: "upstream" | "fork") =>
          makeEnvironment({ homeDirectory, platform, desktopIdentity });
        const official = yield* environmentFor("upstream");
        const officialProfile = path.join(official.appDataDirectory, "T3 Code (Alpha)");
        yield* fileSystem.makeDirectory(officialProfile, { recursive: true });
        yield* fileSystem.writeFileString(path.join(officialProfile, "Local State"), "{}");

        const forkPath = yield* DesktopUserData.resolveUserDataPath(yield* environmentFor("fork"));
        const officialPath = yield* DesktopUserData.resolveUserDataPath(official);

        assert.equal(forkPath, path.join(official.appDataDirectory, "t3code-fork"));
        assert.equal(officialPath, path.join(official.appDataDirectory, "t3code-v2"));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
