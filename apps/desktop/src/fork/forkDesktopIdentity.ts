declare const __T3CODE_BUILD_DESKTOP_IDENTITY__: string | undefined;

export type DesktopIdentity = "upstream" | "fork";

export const FORK_DESKTOP_IDENTITY = {
  productName: "T3 Code (Fork)",
  appId: "com.silthus.t3code.fork",
  userDataDirName: "t3code-fork",
  t3HomeDirName: ".t3-fork",
  artifactName: "T3-Code-Fork-${arch}.${ext}",
} as const;

const UPSTREAM_T3_HOME_DIR_NAME = ".t3";

export function resolveDesktopIdentity(rawIdentity: string | undefined): DesktopIdentity {
  return rawIdentity?.trim() === "fork" ? "fork" : "upstream";
}

export const buildDesktopIdentity: DesktopIdentity = resolveDesktopIdentity(
  typeof __T3CODE_BUILD_DESKTOP_IDENTITY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_DESKTOP_IDENTITY__,
);

export function forkDesktopIdentityDefine(env: Readonly<Record<string, string | undefined>>) {
  return {
    __T3CODE_BUILD_DESKTOP_IDENTITY__: JSON.stringify(
      resolveDesktopIdentity(env.T3CODE_DESKTOP_IDENTITY),
    ),
  };
}

export function resolveRuntimeDesktopIdentity(input: {
  readonly isDevelopment: boolean;
  readonly buildIdentity?: DesktopIdentity | undefined;
}): DesktopIdentity {
  return input.isDevelopment ? "upstream" : (input.buildIdentity ?? buildDesktopIdentity);
}

export function resolveDefaultT3HomeDirName(identity: DesktopIdentity): string {
  return identity === "fork" ? FORK_DESKTOP_IDENTITY.t3HomeDirName : UPSTREAM_T3_HOME_DIR_NAME;
}

export function forkDesktopEnvironmentOverrides<
  Branding extends { readonly displayName: string },
>(input: { readonly desktopIdentity: DesktopIdentity; readonly branding: Branding }) {
  if (input.desktopIdentity !== "fork") {
    return {};
  }
  return {
    branding: { ...input.branding, displayName: FORK_DESKTOP_IDENTITY.productName },
    displayName: FORK_DESKTOP_IDENTITY.productName,
  };
}
