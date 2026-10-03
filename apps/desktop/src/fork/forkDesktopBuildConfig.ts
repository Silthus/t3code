import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { FORK_DESKTOP_IDENTITY, resolveDesktopIdentity } from "./forkDesktopIdentity.ts";

type BuildConfig = Record<string, unknown>;

const DesktopIdentityConfig = Config.String("T3CODE_DESKTOP_IDENTITY").pipe(
  Config.withDefault(""),
  Config.map(resolveDesktopIdentity),
);

function withoutUrlSchemes(platformConfig: unknown): unknown {
  if (typeof platformConfig !== "object" || platformConfig === null) {
    return platformConfig;
  }
  const { protocols: _protocols, ...rest } = platformConfig as BuildConfig;
  return rest;
}

function withForkInstallerTitle(dmgConfig: unknown, version: string): unknown {
  if (typeof dmgConfig !== "object" || dmgConfig === null) {
    return dmgConfig;
  }
  return { ...dmgConfig, title: `${FORK_DESKTOP_IDENTITY.productName} ${version} Installer` };
}

export const applyDesktopIdentityToBuildConfig = Effect.fn("applyDesktopIdentityToBuildConfig")(
  function* (buildConfig: BuildConfig, version: string) {
    if ((yield* DesktopIdentityConfig) !== "fork") {
      return buildConfig;
    }
    const { publish: _publish, ...rest } = buildConfig;
    return {
      ...rest,
      appId: FORK_DESKTOP_IDENTITY.appId,
      productName: FORK_DESKTOP_IDENTITY.productName,
      artifactName: FORK_DESKTOP_IDENTITY.artifactName,
      ...("mac" in rest ? { mac: withoutUrlSchemes(rest.mac) } : {}),
      ...("linux" in rest ? { linux: withoutUrlSchemes(rest.linux) } : {}),
      ...("dmg" in rest ? { dmg: withForkInstallerTitle(rest.dmg, version) } : {}),
    };
  },
);
