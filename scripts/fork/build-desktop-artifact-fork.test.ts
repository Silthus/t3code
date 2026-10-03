import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig } from "../build-desktop-artifact.ts";

const buildConfigFor = (platform: "mac" | "linux", target: string, env: Record<string, string>) =>
  createBuildConfig(platform, target, "0.0.44", false, false, undefined, undefined).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "Silthus/t3code", ...env } }),
      ),
    ),
  );

const urlSchemesOf = (platformConfig: unknown) =>
  (
    platformConfig as { protocols?: ReadonlyArray<{ schemes: ReadonlyArray<string> }> }
  ).protocols?.flatMap((protocol) => protocol.schemes) ?? [];

it.layer(NodeServices.layer)("desktop build identity", (it) => {
  it.effect("builds the upstream identity without the switch", () =>
    Effect.gen(function* () {
      const mac = yield* buildConfigFor("mac", "zip", {});

      assert.equal(mac.appId, "com.t3tools.t3code");
      assert.equal(mac.productName, "T3 Code (Alpha)");
      assert.equal(mac.artifactName, "T3-Code-${version}-${arch}.${ext}");
      assert.deepStrictEqual(urlSchemesOf(mac.mac), ["t3code", "t3code-dev"]);
      assert.property(mac, "publish");
    }),
  );

  it.effect("builds the fork identity side by side with the official app", () =>
    Effect.gen(function* () {
      const mac = yield* buildConfigFor("mac", "zip", { T3CODE_DESKTOP_IDENTITY: "fork" });

      assert.equal(mac.appId, "com.silthus.t3code.fork");
      assert.equal(mac.productName, "T3 Code (Fork)");
      assert.equal(mac.artifactName, "T3-Code-Fork-${arch}.${ext}");
    }),
  );

  it.effect("never claims t3code:// links in a fork build", () =>
    Effect.gen(function* () {
      const mac = yield* buildConfigFor("mac", "zip", { T3CODE_DESKTOP_IDENTITY: "fork" });
      const linux = yield* buildConfigFor("linux", "AppImage", { T3CODE_DESKTOP_IDENTITY: "fork" });

      assert.deepStrictEqual(urlSchemesOf(mac.mac), []);
      assert.deepStrictEqual(urlSchemesOf(linux.linux), []);
      assert.equal((mac.mac as { icon: string }).icon, "icon.icns");
    }),
  );

  it.effect("ships a fork build without an update feed", () =>
    Effect.gen(function* () {
      const mac = yield* buildConfigFor("mac", "zip", { T3CODE_DESKTOP_IDENTITY: "fork" });

      assert.strictEqual(mac.publish, null);
    }),
  );

  it.effect("names a fork installer after the fork", () =>
    Effect.gen(function* () {
      const mac = yield* buildConfigFor("mac", "dmg", { T3CODE_DESKTOP_IDENTITY: "fork" });

      assert.equal((mac.dmg as { title: string }).title, "T3 Code (Fork) 0.0.44 Installer");
    }),
  );
});
