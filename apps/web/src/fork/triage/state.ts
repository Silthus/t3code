import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { loadTriageReport } from "@t3tools/client-runtime/fork/triage";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TriageReport, TriageReportInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

const triageReport = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "fork-triage:report",
  staleTimeMs: 60_000,
  execute: loadTriageReport,
});

const CACHED_READ: TriageReportInput = { refresh: false };
const GITHUB_READ: TriageReportInput = { refresh: true };

export function useTriageEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  return primaryEnvironmentId ?? connectedEnvironmentIds[0] ?? null;
}

export interface TriageReportView {
  readonly report: TriageReport | null;
  readonly loadError: string | null;
  readonly updating: boolean;
  readonly reload: () => void;
  readonly refreshFromGitHub: () => Promise<void>;
}

export function useTriageReport(environmentId: EnvironmentId): TriageReportView {
  const atom = triageReport({ environmentId, input: CACHED_READ });
  const result = useAtomValue(atom);
  const reload = useAtomRefresh(atom);
  const runGitHubRead = useAtomQueryRunner(triageReport, { refresh: true, reportFailure: false });
  const [readingGitHub, setReadingGitHub] = useState(false);

  const refreshFromGitHub = async () => {
    setReadingGitHub(true);
    try {
      await runGitHubRead({ environmentId, input: GITHUB_READ });
      reload();
    } finally {
      setReadingGitHub(false);
    }
  };

  return {
    report: Option.getOrNull(AsyncResult.value(result)),
    loadError: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    updating: result.waiting || readingGitHub,
    reload,
    refreshFromGitHub,
  };
}
