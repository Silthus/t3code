import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  const ensureScratchProject = async (request: { readonly environmentId: string }) => ({
    _tag: "Success" as const,
    value: { projectId: `scratch-${request.environmentId}` },
  });
  return {
    ensureScratchProject,
    settings: {
      loadBalancingEnabled: true,
      loadBalancingWeights: {} as Record<string, number>,
    },
    environments: [] as Array<{
      environmentId: string;
      connection: { phase: string };
      serverConfig: { scratchWorkspaceRoot?: string } | null;
    }>,
    ensureScratch: vi.fn(ensureScratchProject),
  };
});

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.ensureScratch,
}));
vi.mock("~/state/entities", () => ({
  waitForProject: async (projectRef: { environmentId: string; projectId: string }) => ({
    environmentId: projectRef.environmentId,
    id: projectRef.projectId,
  }),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { ensureScratch: {} } }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("./useSettings", () => ({
  useClientSettings: <T>(selector: (settings: typeof testState.settings) => T) =>
    selector(testState.settings),
}));

import { useScratchProject } from "./useScratchProject";

const mac = EnvironmentId.make("mac");
const box = EnvironmentId.make("box");
const vps = EnvironmentId.make("vps");

const connected = (environmentId: string, scratchWorkspaceRoot?: string) => ({
  environmentId,
  connection: { phase: "connected" },
  serverConfig: scratchWorkspaceRoot ? { scratchWorkspaceRoot } : {},
});

const ensuredEnvironmentIds = () =>
  testState.ensureScratch.mock.calls.map(([request]) => request.environmentId);

describe("useScratchProject", () => {
  beforeEach(() => {
    testState.ensureScratch.mockReset().mockImplementation(testState.ensureScratchProject);
    testState.settings = { loadBalancingEnabled: true, loadBalancingWeights: {} };
    testState.environments = [
      connected(mac, "/Users/me/.t3/scratch"),
      connected(box, "/home/me/.t3/scratch"),
      connected(vps),
    ];
  });

  it("prepares a no-project home on every balanced machine that offers one", async () => {
    const project = await useScratchProject().openScratchProject(mac);

    expect(project).toEqual({ environmentId: mac, id: ProjectId.make("scratch-mac") });
    expect(ensuredEnvironmentIds()).toEqual([mac, box]);
  });

  it("keeps the no-project home on the requested machine when balancing is off", async () => {
    testState.settings = { loadBalancingEnabled: false, loadBalancingWeights: {} };

    await useScratchProject().openScratchProject(mac);

    expect(ensuredEnvironmentIds()).toEqual([mac]);
  });

  it("leaves out machines whose balancing weight is zero", async () => {
    testState.settings = { loadBalancingEnabled: true, loadBalancingWeights: { box: 0 } };

    await useScratchProject().openScratchProject(mac);

    expect(ensuredEnvironmentIds()).toEqual([mac]);
  });

  it("opens the requested home when another machine fails to prepare one", async () => {
    testState.ensureScratch.mockImplementation(async (request) =>
      request.environmentId === box
        ? ({ _tag: "Failure", cause: Cause.fail(new Error("offline")) } as never)
        : testState.ensureScratchProject(request),
    );

    const project = await useScratchProject().openScratchProject(mac);

    expect(project).toEqual({ environmentId: mac, id: ProjectId.make("scratch-mac") });
  });
});
