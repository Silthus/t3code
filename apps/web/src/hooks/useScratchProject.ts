import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";

/** How long a draft waits for other balanced machines to prepare their home. */
export const BALANCED_SCRATCH_WAIT_MS = 2_000;

function reportScratchFailure(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not start without a project",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Threads without a project live in the environment's scratch project, a
 * plain folder the server owns (users see it as "No project"). The server
 * creates it on first use; after that it is an ordinary project on the
 * non-git path, and each thread gets its own subfolder.
 */
export function useScratchProject() {
  const { environments } = useEnvironments();
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const loadBalancingWeights = useClientSettings((settings) => settings.loadBalancingWeights);

  /** The scratch folder of a connected environment, or null when it offers none. */
  const scratchWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null => {
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      return environment?.connection.phase === "connected"
        ? (environment.serverConfig?.scratchWorkspaceRoot ?? null)
        : null;
    },
    [environments],
  );

  // A thread without a project starts on the machine the user is working on,
  // and only there. With no current machine (the hosted app with nothing
  // open), it starts on the one machine that offers it, never a silent pick.
  const scratchEnvironmentId = useCallback(
    (current: EnvironmentId | null): EnvironmentId | null => {
      if (current !== null) return scratchWorkspaceRootFor(current) !== null ? current : null;
      const offering = environments.filter(
        (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
      );
      return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
    },
    [environments, scratchWorkspaceRootFor],
  );

  const ensureScratchProject = useCallback(
    async (
      environmentId: EnvironmentId,
      reportFailure: (error: unknown) => void,
    ): Promise<EnvironmentProject | null> => {
      const result = await ensureScratch({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure(squashAtomCommandFailure(result));
        }
        return null;
      }
      // Drafts key off the project's stored path and settings, so wait for
      // the create event to reach the store before targeting one.
      return waitForProject(scopeProjectRef(environmentId, result.value.projectId)).catch(
        (error: unknown) => {
          reportFailure(error);
          return null;
        },
      );
    },
    [ensureScratch],
  );

  // Automatic routing only picks machines that already have the project, so
  // a thread without a project needs its home on every balanced machine. The
  // draft waits briefly so routing sees them all, but a slow machine cannot
  // hold it: routing then decides among the machines that answered in time.
  const balancedScratchEnvironmentIds = useCallback(
    (requested: EnvironmentId): EnvironmentId[] =>
      loadBalancingEnabled
        ? environments
            .map((entry) => entry.environmentId)
            .filter(
              (environmentId) =>
                environmentId !== requested &&
                (loadBalancingWeights[environmentId] ?? 50) > 0 &&
                scratchWorkspaceRootFor(environmentId) !== null,
            )
        : [],
    [environments, loadBalancingEnabled, loadBalancingWeights, scratchWorkspaceRootFor],
  );

  /** Resolves to the scratch project once it is in this client's store. */
  const openScratchProject = useCallback(
    async (environmentId: EnvironmentId): Promise<EnvironmentProject | null> => {
      const otherProjects = Promise.all(
        balancedScratchEnvironmentIds(environmentId).map((otherEnvironmentId) =>
          ensureScratchProject(otherEnvironmentId, () => {}),
        ),
      );
      const [project] = await Promise.all([
        ensureScratchProject(environmentId, reportScratchFailure),
        Promise.race([
          otherProjects,
          new Promise((resolve) => setTimeout(resolve, BALANCED_SCRATCH_WAIT_MS)),
        ]),
      ]);
      return project;
    },
    [balancedScratchEnvironmentIds, ensureScratchProject],
  );

  const startScratchThread = useCallback(
    async (environmentId: EnvironmentId) => {
      const project = await openScratchProject(environmentId);
      if (project) {
        await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
          reportScratchFailure,
        );
      }
    },
    [handleNewThread, openScratchProject],
  );

  return { scratchWorkspaceRootFor, scratchEnvironmentId, openScratchProject, startScratchThread };
}
