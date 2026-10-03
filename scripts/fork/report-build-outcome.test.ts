// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell script against a recording gh stub.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";

const reporter = NodePath.resolve(import.meta.dirname, "report-build-outcome.sh");
const RUN_URL = "https://github.com/Silthus/t3code/actions/runs/42";

let root: string;

const fakeGh = `#!/usr/bin/env bash
printf '%s\\0' "$*" >> "$GH_CALLS"
if [[ "$1 $2" == "issue list" ]]; then printf '%s' "$OPEN_ISSUE"; fi
`;

async function report(outcome: "success" | "failure", openIssue: string) {
  const result = NodeChildProcess.spawnSync("bash", [reporter, outcome], {
    env: {
      ...process.env,
      PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
      GH_CALLS: NodePath.join(root, "calls"),
      OPEN_ISSUE: openIssue,
      GITHUB_REPOSITORY: "Silthus/t3code",
      GITHUB_SHA: "abc1234def",
      RUN_URL,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const calls = await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8");
  return calls
    .split("\0")
    .filter((call) => call !== "")
    .filter((call) => !call.startsWith("issue list"));
}

describe("fork build outcome report", () => {
  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-build-report-"));
    await NodeFSP.mkdir(NodePath.join(root, "bin"));
    await NodeFSP.writeFile(NodePath.join(root, "bin", "gh"), fakeGh, { mode: 0o755 });
  });

  it("opens a fork-build-broken issue when a build breaks", async () => {
    const writes = await report("failure", "");

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^label create fork-build-broken /);
    expect(writes[1]).toMatch(/^issue create .*--label fork-build-broken/);
    expect(writes[1]).toContain(RUN_URL);
    expect(writes[1]).toContain("abc1234");
  });

  it("adds the next broken build to the open issue", async () => {
    const writes = await report("failure", "7");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^issue comment 7 /);
    expect(writes[0]).toContain(RUN_URL);
  });

  it("closes the open issue once a build is green again", async () => {
    const writes = await report("success", "7");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^issue close 7 /);
    expect(writes[0]).toContain(RUN_URL);
  });

  it("stays quiet when a green build follows a green build", async () => {
    expect(await report("success", "")).toEqual([]);
  });
});
