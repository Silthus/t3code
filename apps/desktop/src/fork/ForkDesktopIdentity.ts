export const FORK_APP_NAME = "T3 Code Fork";
export const FORK_APP_BUNDLE_ID = "com.t3tools.t3code.fork";

export const FORK_ENVIRONMENT_VARIABLES = {
  appName: "T3CODE_DESKTOP_APP_NAME",
  appBundleId: "T3CODE_DESKTOP_APP_USER_MODEL_ID",
  userDataDirectory: "T3CODE_DESKTOP_USER_DATA_DIR",
  t3Home: "T3CODE_HOME",
  disableAutoUpdate: "T3CODE_DISABLE_AUTO_UPDATE",
} as const;

export interface ForkPaths {
  readonly t3Home: string;
  readonly userDataDirectory: string;
  readonly secretsFile: string;
}

export function resolveForkPaths(input: {
  readonly homeDirectory: string;
  readonly joinPath: (first: string, ...segments: string[]) => string;
}): ForkPaths {
  const root = input.joinPath(input.homeDirectory, "Library", "Application Support", FORK_APP_NAME);
  return {
    t3Home: input.joinPath(root, "t3-home"),
    userDataDirectory: input.joinPath(root, "user-data"),
    secretsFile: input.joinPath(root, "secrets.env"),
  };
}
