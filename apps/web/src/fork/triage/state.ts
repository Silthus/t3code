import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { assessTriagePullRequest, loadTriageReport } from "@t3tools/client-runtime/fork/triage";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_TRIAGE_PREFERENCES,
  type EnvironmentId,
  type TriagePreferences,
  type TriageReport,
  type TriageReportInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

const reportFamily = (preferences: TriagePreferences) =>
  createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "fork-triage:report",
    staleTimeMs: 60_000,
    execute: (input: { refresh: boolean }) => loadTriageReport({ ...input, preferences }),
  });
const reportsByPreferences = new WeakMap<TriagePreferences, ReturnType<typeof reportFamily>>();
const triageReport = (target: { environmentId: EnvironmentId; input: TriageReportInput }) => {
  const preferences = target.input.preferences ?? DEFAULT_TRIAGE_PREFERENCES;
  let family = reportsByPreferences.get(preferences);
  if (!family) {
    family = reportFamily(preferences);
    reportsByPreferences.set(preferences, family);
  }
  return family({ environmentId: target.environmentId, input: { refresh: target.input.refresh } });
};

const triageAssess = createEnvironmentCommand(connectionAtomRuntime, {
  label: "fork-triage:assess",
  execute: assessTriagePullRequest,
});

export function useAssessTriage() {
  const assess = useAtomCommand(triageAssess, { reportFailure: false });
  const environmentId = useTriageEnvironmentId();
  return { assess, environmentId };
}

export function useReloadTriage(environmentId: EnvironmentId) {
  const { triagePreferences } = useClientSettings();
  return useAtomRefresh(
    triageReport({ environmentId, input: { refresh: false, preferences: triagePreferences } }),
  );
}

export function useTriageEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  return primaryEnvironmentId ?? connectedEnvironmentIds[0] ?? null;
}

interface RefreshFailure {
  readonly message: string;
  readonly at: number;
}

function unansweredRefreshFailure(
  failure: RefreshFailure | null,
  result: AsyncResult.AsyncResult<TriageReport, unknown>,
): string | null {
  if (failure === null) return null;
  const answeredLater = result._tag === "Success" && result.timestamp > failure.at;
  return answeredLater ? null : `Refresh failed: ${failure.message}`;
}

export interface TriageReportView {
  readonly report: TriageReport | null;
  readonly loadError: string | null;
  readonly updating: boolean;
  readonly reload: () => void;
  readonly refreshFromGitHub: () => Promise<void>;
}

export function useTriageReport(environmentId: EnvironmentId): TriageReportView {
  const { triagePreferences } = useClientSettings();
  const atom = triageReport({
    environmentId,
    input: { refresh: false, preferences: triagePreferences },
  });
  const result = useAtomValue(atom);
  const reload = useAtomRefresh(atom);
  const runGitHubRead = useAtomQueryRunner(triageReport, { refresh: true, reportFailure: false });
  const [readingGitHub, setReadingGitHub] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<RefreshFailure | null>(null);

  const refreshFromGitHub = async () => {
    setReadingGitHub(true);
    try {
      const read = await runGitHubRead({
        environmentId,
        input: { refresh: true, preferences: triagePreferences },
      });
      if (read._tag === "Failure") {
        if (!isAtomCommandInterrupted(read)) {
          setRefreshFailure({ message: formatEnvironmentQueryError(read.cause), at: Date.now() });
        }
        return;
      }
      setRefreshFailure(null);
      reload();
    } finally {
      setReadingGitHub(false);
    }
  };

  const report = Option.getOrNull(AsyncResult.value(result));
  const pending = report?.pullRequests.some((pr) => pr.judgement._tag === "pending") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(reload, 10_000);
    return () => window.clearInterval(timer);
  }, [pending, reload]);

  return {
    report,
    loadError:
      result._tag === "Failure"
        ? formatEnvironmentQueryError(result.cause)
        : unansweredRefreshFailure(refreshFailure, result),
    updating: result.waiting || readingGitHub,
    reload,
    refreshFromGitHub,
  };
}
