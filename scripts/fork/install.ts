// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off - This is a standalone macOS launcher and installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  FORK_APP_NAME,
  FORK_APP_BUNDLE_ID,
  FORK_ENVIRONMENT_VARIABLES,
  resolveForkPaths,
} from "../../apps/desktop/src/fork/ForkDesktopIdentity.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const desktopRoot = NodePath.join(repositoryRoot, "apps", "desktop");
const applicationDirectory = NodePath.join(NodeOS.homedir(), "Applications");
const applicationPath = NodePath.join(applicationDirectory, `${FORK_APP_NAME}.app`);
const forkPaths = resolveForkPaths({ homeDirectory: NodeOS.homedir(), joinPath: NodePath.join });
const forkEnvironmentFile = forkPaths.secretsFile;
const launcherLogPath = NodePath.join(forkPaths.t3Home, "userdata", "logs", "fork-launcher.log");

interface ForkLaunchMetadata {
  readonly repositoryRoot: string;
  readonly applicationPath: string;
  readonly electronBinaryPath: string;
  readonly t3Home: string;
  readonly userDataDirectory: string;
  readonly environmentFile: string;
  readonly bundleId: string;
  readonly displayName: string;
  readonly launcherLogPath: string;
}

function runChecked(command: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync(command, [...args], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(`Command failed: ${command} ${args.join(" ")}\n${details}`.trim());
}

function setPlistValue(plistPath: string, key: string, value: string): void {
  const replace = NodeChildProcess.spawnSync(
    "/usr/bin/plutil",
    ["-replace", key, "-string", value, plistPath],
    { encoding: "utf8" },
  );
  if (replace.status === 0) return;

  runChecked("/usr/bin/plutil", ["-insert", key, "-string", value, plistPath]);
}

function patchHelperBundleInfoPlists(applicationPathToPatch: string): void {
  const helperBundles = [
    ["Electron Helper.app", "helper", `${FORK_APP_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${FORK_APP_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${FORK_APP_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${FORK_APP_NAME} Helper (Renderer)`],
  ] as const;

  for (const [bundleName, identifierSuffix, displayName] of helperBundles) {
    const plistPath = NodePath.join(
      applicationPathToPatch,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!NodeFS.existsSync(plistPath)) continue;
    setPlistValue(plistPath, "CFBundleDisplayName", displayName);
    setPlistValue(plistPath, "CFBundleName", displayName);
    setPlistValue(plistPath, "CFBundleIdentifier", `${FORK_APP_BUNDLE_ID}.${identifierSuffix}`);
  }
}

function resolveElectronBinaryPath(): string {
  const desktopPackageJson = NodePath.join(desktopRoot, "package.json");
  const require = NodeModule.createRequire(desktopPackageJson);
  const electronBinary = require("electron");
  if (typeof electronBinary !== "string" || !NodePath.isAbsolute(electronBinary)) {
    throw new Error("The desktop Electron binary path is not absolute.");
  }
  return electronBinary;
}

function resolveMetadata(electronBinaryPath: string): ForkLaunchMetadata {
  return {
    repositoryRoot,
    applicationPath,
    electronBinaryPath,
    t3Home: forkPaths.t3Home,
    userDataDirectory: forkPaths.userDataDirectory,
    environmentFile: forkEnvironmentFile,
    bundleId: FORK_APP_BUNDLE_ID,
    displayName: FORK_APP_NAME,
    launcherLogPath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createEnvironmentFile(): void {
  NodeFS.mkdirSync(NodePath.dirname(forkEnvironmentFile), { recursive: true, mode: 0o700 });
  if (NodeFS.existsSync(forkEnvironmentFile)) {
    NodeFS.chmodSync(forkEnvironmentFile, 0o600);
    return;
  }

  NodeFS.writeFileSync(
    forkEnvironmentFile,
    "# Optional local secrets for T3 Code Fork. This file is never copied to the repository.\n",
    { mode: 0o600 },
  );
}

function installApplication(): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone launcher has no Effect runtime.
  if (NodeOS.platform() !== "darwin") {
    throw new Error("T3 Code Fork installation currently supports macOS only.");
  }

  const electronBinaryPath = resolveElectronBinaryPath();
  const sourceApplicationPath = NodePath.resolve(NodePath.dirname(electronBinaryPath), "../..");
  const temporaryApplicationPath = `${applicationPath}.tmp-${process.pid}`;
  NodeFS.mkdirSync(applicationDirectory, { recursive: true });
  NodeFS.rmSync(temporaryApplicationPath, { recursive: true, force: true });
  NodeFS.cpSync(sourceApplicationPath, temporaryApplicationPath, {
    recursive: true,
    verbatimSymlinks: true,
  });

  const infoPlistPath = NodePath.join(temporaryApplicationPath, "Contents", "Info.plist");
  const executableName = FORK_APP_NAME;
  setPlistValue(infoPlistPath, "CFBundleDisplayName", FORK_APP_NAME);
  setPlistValue(infoPlistPath, "CFBundleName", FORK_APP_NAME);
  setPlistValue(infoPlistPath, "CFBundleIdentifier", FORK_APP_BUNDLE_ID);
  setPlistValue(infoPlistPath, "CFBundleExecutable", executableName);
  // The renderer's t3code-dev:// URL is process-local. Registering it with
  // LaunchServices would make this app compete with ordinary dev installs for
  // external protocol activations without providing any useful behavior.
  patchHelperBundleInfoPlists(temporaryApplicationPath);

  const executablePath = NodePath.join(
    temporaryApplicationPath,
    "Contents",
    "MacOS",
    executableName,
  );
  const launchScript = [
    "#!/bin/sh",
    "set -eu",
    // Finder does not inherit the interactive shell's tool paths.
    `export PATH=${shellQuote([NodePath.dirname(process.execPath), ...(process.env.PATH ?? "").split(NodePath.delimiter).filter(NodePath.isAbsolute)].join(NodePath.delimiter))}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(NodePath.join(repositoryRoot, "scripts/fork/install.ts"))} run --app-path ${shellQuote(applicationPath)} "$@"`,
    "",
  ].join("\n");
  NodeFS.writeFileSync(executablePath, launchScript, { mode: 0o755 });
  NodeFS.chmodSync(executablePath, 0o755);
  runChecked("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    temporaryApplicationPath,
  ]);
  NodeFS.rmSync(applicationPath, { recursive: true, force: true });
  NodeFS.renameSync(temporaryApplicationPath, applicationPath);
  createEnvironmentFile();
  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", applicationPath],
  );
  console.log(`Installed ${FORK_APP_NAME} at ${applicationPath}`);
  console.log(`Separate runtime home: ${forkPaths.t3Home}`);
  console.log(`Separate Electron session data: ${forkPaths.userDataDirectory}`);
  console.log(`Secrets file: ${forkEnvironmentFile}`);
}

function readEnvironmentFile(): Record<string, string> {
  if (!NodeFS.existsSync(forkEnvironmentFile)) return {};
  const output: Record<string, string> = {};
  for (const rawLine of NodeFS.readFileSync(forkEnvironmentFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const value = match[2].trim();
    output[match[1]] =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value.startsWith("'") && value.endsWith("'")
          ? value.slice(1, -1)
          : value;
  }
  return output;
}

function makeForkEnvironment(extra: Readonly<Record<string, string | undefined>> = {}) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // An agent can start this launcher from another T3 installation.
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("T3CODE_") ||
      name.startsWith("VITE_") ||
      name.startsWith("T3_SERVICE_") ||
      name === "T3_BOOT_SERVICE_UNIT"
    )
      delete environment[name];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  Object.assign(environment, readEnvironmentFile(), extra);
  environment[FORK_ENVIRONMENT_VARIABLES.t3Home] = forkPaths.t3Home;
  environment[FORK_ENVIRONMENT_VARIABLES.userDataDirectory] = forkPaths.userDataDirectory;
  environment[FORK_ENVIRONMENT_VARIABLES.appName] = FORK_APP_NAME;
  environment[FORK_ENVIRONMENT_VARIABLES.appBundleId] = FORK_APP_BUNDLE_ID;
  environment[FORK_ENVIRONMENT_VARIABLES.disableAutoUpdate] = "1";
  environment.T3CODE_FORK_LAUNCH = "1";
  environment.T3CODE_TRIAGE_AUTOSTART ??= "true";
  environment.T3CODE_DEV_INSTANCE = "t3code-fork";
  // The fork starts Electron through the process-local t3code-dev protocol.
  // Bundling the Vite module graph avoids one custom-protocol request per
  // import, which otherwise exhausts Electron's loader on a cold graph.
  environment.T3CODE_BUNDLED_DEV = "1";
  return environment;
}

async function waitForForkResources(webUrl: string, readyDirectory: string): Promise<void> {
  const requiredFiles = [
    NodePath.join(desktopRoot, "dist-electron", "main.cjs"),
    NodePath.join(desktopRoot, "dist-electron", "preload.cjs"),
    NodePath.join(repositoryRoot, "apps", "server", "dist", "bin.mjs"),
    NodePath.join(readyDirectory, "main"),
    NodePath.join(readyDirectory, "preload"),
  ];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (requiredFiles.every((filePath) => NodeFS.existsSync(filePath))) {
      try {
        const response = await fetch(webUrl);
        if (response.ok || response.status < 500) return;
      } catch {
        // The dev server may still be starting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The fork dev runtime did not produce its Electron and Vite resources in time.");
}

function launchDevelopmentRuntime(appPath: string, args: readonly string[]): Promise<number> {
  const environment = makeForkEnvironment();
  // Only this build can produce these markers. Existing bundles are not a readiness signal.
  const readyDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-code-fork-build-"));
  environment.T3CODE_FORK_READY_DIR = readyDirectory;
  NodeFS.mkdirSync(NodePath.dirname(launcherLogPath), { recursive: true, mode: 0o700 });
  const launcherLog = NodeFS.createWriteStream(launcherLogPath, { flags: "a", mode: 0o600 });
  let logClosed = false;
  const writeLog = (message: string): void => {
    if (logClosed) return;
    launcherLog.write(`[${new Date().toISOString()}] ${message}\n`);
  };
  const forwardOutput = (chunk: Buffer, output: NodeJS.WriteStream): void => {
    output.write(chunk);
    if (logClosed) return;
    launcherLog.write(chunk);
  };
  writeLog(`starting fork launcher pid=${String(process.pid)}`);
  const runner = NodeChildProcess.spawn(
    process.execPath,
    ["run", "dev:desktop", "--", "--home-dir", forkPaths.t3Home],
    { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  const stopRunner = () => {
    if (runner.pid === undefined) return;
    writeLog(`stopping captured dev runner process group pid=${String(runner.pid)}`);
    try {
      process.kill(-runner.pid, "SIGTERM");
    } catch {
      /* The captured group has exited. */
    }
  };
  const closeLog = () => {
    if (logClosed) return;
    logClosed = true;
    launcherLog.end();
    NodeFS.rmSync(readyDirectory, { recursive: true, force: true });
  };
  let launchStarted = false;
  let runnerExited = false;
  let outputBuffer = "";
  let electron: NodeChildProcess.ChildProcess | undefined;
  let resolveResult: (value: number) => void = () => undefined;
  let rejectResult: (reason: Error) => void = () => undefined;
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const startElectron = async (serverPort: string, webPort: string): Promise<void> => {
    await waitForForkResources(`http://127.0.0.1:${webPort}/`, readyDirectory);
    if (runnerExited) {
      throw new Error("The dev runner exited before Electron could start.");
    }
    const electronEnvironment = makeForkEnvironment({
      T3CODE_PORT: serverPort,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${webPort}`,
    });
    electron = NodeChildProcess.spawn(
      NodePath.join(appPath, "Contents", "MacOS", "Electron"),
      [
        `--t3code-dev-root=${desktopRoot}`,
        NodePath.join(desktopRoot, "dist-electron", "main.cjs"),
        ...args,
      ],
      { cwd: desktopRoot, env: electronEnvironment, stdio: ["ignore", "pipe", "pipe"] },
    );
    electron.stdout?.on("data", (chunk: Buffer) => forwardOutput(chunk, process.stdout));
    electron.stderr?.on("data", (chunk: Buffer) => forwardOutput(chunk, process.stderr));
    electron.once("error", (cause) => {
      writeLog(`Electron failed to start: ${cause.message}`);
      stopRunner();
      closeLog();
      rejectResult(cause);
    });
    electron.once("exit", (code, signal) => {
      writeLog(`Electron exited code=${String(code)} signal=${String(signal)}`);
      if (signal) {
        stopRunner();
        closeLog();
        resolveResult(1);
      } else {
        stopRunner();
        closeLog();
        resolveResult(code ?? 0);
      }
    });
  };

  const forwardRunnerOutput = (chunk: Buffer): void => {
    const text = chunk.toString();
    forwardOutput(chunk, process.stdout);
    if (launchStarted) return;
    outputBuffer = (outputBuffer + text).slice(-16_384);
    const match = /\[dev-runner\].*serverPort=([^ ]+) webPort=([^ ]+)/.exec(outputBuffer);
    if (launchStarted || !match?.[1] || !match[2]) return;
    launchStarted = true;
    outputBuffer = "";
    void startElectron(match[1], match[2]).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error("Fork launch failed");
      writeLog(`fork launch failed: ${failure.message}`);
      stopRunner();
      closeLog();
      rejectResult(failure);
    });
  };

  runner.stdout?.on("data", forwardRunnerOutput);
  runner.stderr?.on("data", (chunk: Buffer) => forwardOutput(chunk, process.stderr));
  runner.once("error", (cause) => {
    runnerExited = true;
    writeLog(`dev runner failed to start: ${cause.message}`);
    electron?.kill("SIGTERM");
    closeLog();
    rejectResult(cause);
  });
  runner.once("exit", (code) => {
    runnerExited = true;
    writeLog(`dev runner exited code=${String(code)}`);
    if (!launchStarted) {
      closeLog();
      rejectResult(
        new Error(`The dev runner exited before Electron started (code ${String(code)}).`),
      );
      return;
    }
    electron?.kill("SIGTERM");
    closeLog();
    rejectResult(new Error(`The dev runner exited after Electron started (code ${String(code)}).`));
  });
  process.once("SIGINT", () => {
    electron?.kill("SIGINT");
    stopRunner();
    closeLog();
  });
  process.once("SIGTERM", () => {
    electron?.kill("SIGTERM");
    stopRunner();
    closeLog();
  });
  return result;
}

function inspectApplication(): void {
  const metadata = resolveMetadata(resolveElectronBinaryPath());
  console.log(
    JSON.stringify({ ...metadata, installed: NodeFS.existsSync(applicationPath) }, null, 2),
  );
}

function uninstallApplication(): void {
  if (NodeFS.existsSync(applicationPath)) {
    NodeFS.rmSync(applicationPath, { recursive: true, force: true });
    console.log(`Removed ${applicationPath}`);
  } else {
    console.log(`${FORK_APP_NAME} is not installed at ${applicationPath}`);
  }
  console.log(`Runtime data was kept at ${NodePath.dirname(forkPaths.t3Home)}.`);
}

function git(args: readonly string[]): string {
  return runChecked("/usr/bin/git", args);
}

function syncForkBranch(args: readonly string[]): void {
  const remoteIndex = args.indexOf("--remote");
  const remote = remoteIndex >= 0 ? args[remoteIndex + 1] : "upstream";
  if (!remote) throw new Error("--remote requires a remote name.");
  const branch = process.env.T3CODE_FORK_BRANCH?.trim() || "t3code/build-github-pr-monitor";
  if (git(["status", "--porcelain"]).length > 0) {
    throw new Error("Refusing to sync with a dirty working tree.");
  }
  const currentBranch = git(["branch", "--show-current"]);
  if (currentBranch !== branch) {
    throw new Error(
      `Refusing to sync from ${currentBranch || "a detached HEAD"}; use fork branch ${branch}.`,
    );
  }
  git(["fetch", remote, "main"]);
  git(["merge", "--no-edit", `${remote}/main`]);
  console.log(`Fork branch ${branch} is synced with ${remote}/main.`);
}

const [command = "inspect", ...args] = process.argv.slice(2);
switch (command) {
  case "install":
    installApplication();
    break;
  case "launch":
    runChecked("/usr/bin/open", ["-a", applicationPath]);
    break;
  case "run":
    {
      const appPathIndex = args.indexOf("--app-path");
      const appPath = appPathIndex >= 0 ? args[appPathIndex + 1] : applicationPath;
      if (!appPath) throw new Error("The fork launcher requires an app path.");
      const launchArgs =
        appPathIndex >= 0
          ? [...args.slice(0, appPathIndex), ...args.slice(appPathIndex + 2)]
          : args;
      process.exitCode = await launchDevelopmentRuntime(appPath, launchArgs);
    }
    break;
  case "inspect":
    inspectApplication();
    break;
  case "uninstall":
    uninstallApplication();
    break;
  case "sync":
    syncForkBranch(args);
    break;
  default:
    throw new Error(`Unknown fork command: ${command}`);
}
