// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against fixture zips on disk.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";

const APP_NAME = "T3 Code (Fork).app";
const installer = NodePath.resolve(import.meta.dirname, "install-mac.sh");

let root: string;
let installDir: string;

const installedApp = () => NodePath.join(installDir, APP_NAME);

async function zipWithApp(marker: string) {
  const staging = await NodeFSP.mkdtemp(NodePath.join(root, "staging-"));
  const app = NodePath.join(staging, APP_NAME);
  await NodeFSP.mkdir(NodePath.join(app, "Contents"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(app, "Contents", marker), marker);
  NodeChildProcess.execFileSync("xattr", ["-w", "com.apple.quarantine", "0081;0;Safari;", app]);
  const zip = NodePath.join(root, `${marker}.zip`);
  NodeChildProcess.execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  return zip;
}

function runInstaller(downloadUrl: string) {
  return NodeChildProcess.spawnSync("bash", [installer], {
    env: {
      ...process.env,
      T3CODE_FORK_INSTALL_DIR: installDir,
      T3CODE_FORK_DOWNLOAD_URL: downloadUrl,
    },
    encoding: "utf8",
  });
}

function hasQuarantine(path: string) {
  const listed = NodeChildProcess.execFileSync("xattr", ["-r", path], { encoding: "utf8" });
  return listed.includes("com.apple.quarantine");
}

describe.skipIf(HostProcessPlatform.defaultValue() !== "darwin")("fork Mac installer", () => {
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-install-"));
    installDir = NodePath.join(root, "Applications");
    await NodeFSP.mkdir(installDir);
  });

  it("installs the downloaded app without a quarantine flag", async () => {
    const zip = await zipWithApp("new-build");

    const result = runInstaller(`file://${zip}`);

    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(installedApp(), "Contents", "new-build"))).toBe(true);
    expect(hasQuarantine(installedApp())).toBe(false);
  });

  it("replaces an earlier install", async () => {
    runInstaller(`file://${await zipWithApp("old-build")}`);

    const result = runInstaller(`file://${await zipWithApp("new-build")}`);

    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(installedApp(), "Contents", "new-build"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(installedApp(), "Contents", "old-build"))).toBe(false);
  });

  it("keeps the installed app when the download fails", async () => {
    runInstaller(`file://${await zipWithApp("old-build")}`);

    const result = runInstaller(`file://${NodePath.join(root, "missing.zip")}`);

    expect(result.status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(installedApp(), "Contents", "old-build"))).toBe(true);
  });

  it("keeps the installed app when the download holds no app", async () => {
    runInstaller(`file://${await zipWithApp("old-build")}`);
    const notAnApp = NodePath.join(root, "README.txt");
    await NodeFSP.writeFile(notAnApp, "no app here");
    const zip = NodePath.join(root, "empty.zip");
    NodeChildProcess.execFileSync("ditto", ["-c", "-k", notAnApp, zip]);

    const result = runInstaller(`file://${zip}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(APP_NAME);
    expect(NodeFS.existsSync(NodePath.join(installedApp(), "Contents", "old-build"))).toBe(true);
  });
});
