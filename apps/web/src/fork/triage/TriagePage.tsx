import type {
  EnvironmentId,
  TriageGroup,
  TriagePullRequest,
  TriageReport,
} from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import { useMemo } from "react";

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
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { groupTriagePullRequests, type TriagePullRequestGroup } from "./grouping.logic";
import { TriageRow } from "./TriageRow";
import { useTriageEnvironmentId, useTriageReport, type TriageReportView } from "./state";

const GROUP_LABELS: Record<TriageGroup, string> = {
  "needs-you": "Needs you",
  "ready-to-merge": "Ready to merge",
  "waiting-on-others": "Waiting on others",
  drafts: "Drafts",
};

function UpdatedLabel({ updating, fetchedAt }: { updating: boolean; fetchedAt: string | null }) {
  useNowMinute();
  if (updating) return <span>Updating…</span>;
  if (fetchedAt === null) return null;
  return <span>Updated {formatRelativeTimeLabel(fetchedAt)}</span>;
}

function GroupCounts({ groups }: { groups: ReadonlyArray<TriagePullRequestGroup> }) {
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

function TriageGroups({ groups }: { groups: ReadonlyArray<TriagePullRequestGroup> }) {
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

function ReadFailure({ report }: { report: TriageReport }) {
  if (report.error === null) return null;
  return report.fetchedAt === null ? (
    <ErrorLine message={report.error} />
  ) : (
    <ErrorLine message={`${report.error} Showing the last good list.`} />
  );
}

function TriageNotices({ view }: { view: TriageReportView }) {
  const { report, loadError } = view;
  if (report?.error == null && loadError === null) return null;
  return (
    <WorkspacePageContainer width="wide" className="gap-1 py-2">
      {report ? <ReadFailure report={report} /> : null}
      {loadError !== null ? <ErrorLine message={loadError} /> : null}
    </WorkspacePageContainer>
  );
}

function TriageBody({
  view,
  groups,
}: {
  view: TriageReportView;
  groups: ReadonlyArray<TriagePullRequestGroup>;
}) {
  const { report, loadError } = view;
  if (report === null) {
    return loadError === null ? (
      <p className="text-sm text-muted-foreground">Loading pull requests…</p>
    ) : null;
  }
  return report.fetchedAt !== null ? <TriageGroups groups={groups} /> : null;
}

function TriageHeader({
  view,
  groups,
}: {
  view: TriageReportView | null;
  groups: ReadonlyArray<TriagePullRequestGroup>;
}) {
  return (
    <WorkspacePageHeader
      electron={isElectron}
      className="h-auto min-h-(--workspace-topbar-height) flex-wrap py-2"
    >
      <WorkspaceBreadcrumb ariaLabel="Triage breadcrumb" className="shrink-0">
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">Triage</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <GroupCounts groups={groups} />
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

const NO_PULL_REQUESTS: ReadonlyArray<TriagePullRequest> = [];

function TriageLayout({ view }: { view: TriageReportView | null }) {
  const pullRequests = view?.report?.pullRequests ?? NO_PULL_REQUESTS;
  const groups = useMemo(() => groupTriagePullRequests(pullRequests), [pullRequests]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <TriageHeader view={view} groups={groups} />
        {view ? <TriageNotices view={view} /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide" className="gap-5">
            {view ? (
              <TriageBody view={view} groups={groups} />
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
