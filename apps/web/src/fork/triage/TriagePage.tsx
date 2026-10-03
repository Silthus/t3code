import type { EnvironmentId, TriageGroup, TriageReport } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { groupTriagePullRequests } from "./grouping.logic";
import { TriageRow } from "./TriageRow";
import { useTriageEnvironmentId, useTriageReport, type TriageReportView } from "./state";

const GROUP_LABELS: Record<TriageGroup, string> = {
  "needs-you": "Needs you",
  "ready-to-merge": "Ready to merge",
  "waiting-on-others": "Waiting on others",
  drafts: "Drafts",
};

const UPDATED_LABEL_TICK_MS = 30_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function UpdatedLabel({ updating, fetchedAt }: { updating: boolean; fetchedAt: string | null }) {
  useNow(UPDATED_LABEL_TICK_MS);
  if (updating) return <span>Updating…</span>;
  if (fetchedAt === null) return null;
  return <span>Updated {formatRelativeTimeLabel(fetchedAt)}</span>;
}

function GroupCounts({ report }: { report: TriageReport }) {
  const groups = useMemo(() => groupTriagePullRequests(report.pullRequests), [report]);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {groups.map(({ group, pullRequests }) => (
        <Badge key={group} variant="outline">
          {GROUP_LABELS[group]} {pullRequests.length}
        </Badge>
      ))}
    </span>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
      <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

function TriageGroups({ report }: { report: TriageReport }) {
  const groups = useMemo(() => groupTriagePullRequests(report.pullRequests), [report]);
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No open pull requests of yours.</p>;
  }
  return groups.map(({ group, pullRequests }) => (
    <section key={group} aria-label={GROUP_LABELS[group]} className="flex flex-col gap-1">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {GROUP_LABELS[group]} · {pullRequests.length}
      </h2>
      <ul className="flex flex-col">
        {pullRequests.map((pullRequest) => (
          <TriageRow
            key={`${pullRequest.key.repository}#${pullRequest.key.number}`}
            pullRequest={pullRequest}
          />
        ))}
      </ul>
    </section>
  ));
}

function TriageBody({ view }: { view: TriageReportView }) {
  const { report, loadError } = view;
  if (report === null) {
    if (loadError !== null) return <ErrorLine message={loadError} />;
    return <p className="text-sm text-muted-foreground">Reading your pull requests from GitHub…</p>;
  }
  return (
    <>
      {report.error !== null ? (
        <ErrorLine message={`GitHub read failed, showing the last good list: ${report.error}`} />
      ) : null}
      {loadError !== null ? <ErrorLine message={loadError} /> : null}
      <TriageGroups report={report} />
    </>
  );
}

function TriageHeader({ view }: { view: TriageReportView | null }) {
  return (
    <WorkspacePageHeader electron={isElectron} className="h-auto min-h-(--workspace-topbar-height)">
      <WorkspaceBreadcrumb ariaLabel="Triage breadcrumb">
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">Triage</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {view?.report ? <GroupCounts report={view.report} /> : null}
      <span className="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {view ? (
          <>
            <UpdatedLabel updating={view.updating} fetchedAt={view.report?.fetchedAt ?? null} />
            <Button
              onClick={() => void view.refreshFromGitHub()}
              aria-label="Refresh triage from GitHub"
              aria-busy={view.updating}
              disabled={view.updating}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshIcon size="sm" />
            </Button>
          </>
        ) : null}
      </span>
    </WorkspacePageHeader>
  );
}

function TriageLayout({ view }: { view: TriageReportView | null }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <TriageHeader view={view} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide" className="gap-5">
            {view ? (
              <TriageBody view={view} />
            ) : (
              <p className="text-sm text-muted-foreground">Connect an environment to see triage.</p>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function TriageEnvironmentPage({ environmentId }: { environmentId: EnvironmentId }) {
  const view = useTriageReport(environmentId);
  useLiveRefresh(view.reload, { key: `fork-triage:${environmentId}` });
  return <TriageLayout view={view} />;
}

export function TriagePage() {
  useEscapeToGoBack();
  const environmentId = useTriageEnvironmentId();
  return environmentId === null ? (
    <TriageLayout view={null} />
  ) : (
    <TriageEnvironmentPage key={environmentId} environmentId={environmentId} />
  );
}
