import type {
  EnvironmentId,
  TriageGroup,
  TriagePullRequest,
  TriageReport,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  useClientSettingsHydrationStatus,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { groupTriagePullRequests, type TriagePullRequestGroup } from "./grouping.logic";
import { TriagePreferencesEditor } from "./TriagePreferencesEditor";
import { TriageDetailPane } from "./TriageDetailPane";
import { focusTriageRowSoon, TriageRow } from "./TriageRow";
import { isSelectedPullRequest, type TriageSearch } from "./selection.logic";
import { useTriageEnvironmentId, useTriageReport, type TriageReportView } from "./state";

interface TriageSelection {
  readonly search: TriageSearch;
  readonly select: (pullRequest: TriagePullRequest) => void;
  readonly clear: () => void;
}

function useTriageSelection(): TriageSelection {
  const search = useSearch({ from: "/_chat/triage" });
  const navigate = useNavigate();
  const select = useCallback(
    ({ key }: TriagePullRequest) =>
      void navigate({
        to: "/triage",
        search: { repository: key.repository, number: key.number },
        replace: true,
      }),
    [navigate],
  );
  const clear = useCallback(
    () => void navigate({ to: "/triage", search: {}, replace: true }),
    [navigate],
  );
  return { search, select, clear };
}

function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"))
  );
}

function useEscapeLeavesFieldFirst(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!isEditableTarget(event.target)) return;
      event.preventDefault();
      event.target.blur();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}

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

function TriageGroups({
  groups,
  selection,
}: {
  groups: ReadonlyArray<TriagePullRequestGroup>;
  selection: TriageSelection;
}) {
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
            selected={isSelectedPullRequest(pullRequest, selection.search)}
            onSelect={selection.select}
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
  selection,
}: {
  view: TriageReportView;
  groups: ReadonlyArray<TriagePullRequestGroup>;
  selection: TriageSelection;
}) {
  const { report, loadError } = view;
  if (report === null) {
    return loadError === null ? (
      <p className="text-sm text-muted-foreground">Loading pull requests…</p>
    ) : null;
  }
  return report.fetchedAt !== null ? <TriageGroups groups={groups} selection={selection} /> : null;
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
      <TriagePreferencesEditor pullRequests={view?.report?.pullRequests ?? NO_PULL_REQUESTS} />
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

function TriageLayout({
  view,
  selection,
  detail,
  listRef,
  preferencesNotice,
}: {
  view: TriageReportView | null;
  selection: TriageSelection;
  detail: ReactNode;
  listRef?: Ref<HTMLDivElement>;
  preferencesNotice?: ReactNode;
}) {
  const pullRequests = view?.report?.pullRequests ?? NO_PULL_REQUESTS;
  const groups = useMemo(() => groupTriagePullRequests(pullRequests), [pullRequests]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <TriageHeader view={view} groups={groups} />
        {view ? <TriageNotices view={view} /> : null}
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={listRef}
            tabIndex={-1}
            role="region"
            aria-label="Triage pull requests"
            className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", detail && "max-lg:invisible")}
          >
            <WorkspacePageContainer width="wide" className="gap-5">
              {view ? (
                <TriageBody view={view} groups={groups} selection={selection} />
              ) : (
                (preferencesNotice ?? (
                  <p className="text-sm text-muted-foreground">
                    Connect an environment to see triage.
                  </p>
                ))
              )}
            </WorkspacePageContainer>
          </div>
          {detail ? (
            <div className="min-h-0 min-w-0 border-border bg-background max-lg:absolute max-lg:inset-0 lg:w-1/2 lg:shrink-0 lg:border-s">
              {detail}
            </div>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function TriageEnvironmentPage({
  environmentId,
  selection,
}: {
  environmentId: EnvironmentId;
  selection: TriageSelection;
}) {
  const view = useTriageReport(environmentId);
  useLiveRefresh(view.reload, { key: `fork-triage:${environmentId}` });
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const refreshEverything = () => {
    setDetailRefreshToken((token) => token + 1);
    return view.refreshFromGitHub();
  };
  const selected = view.report?.pullRequests.find((pullRequest) =>
    isSelectedPullRequest(pullRequest, selection.search),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const previousSelection = useRef(selected);
  const { clear: clearSelection, search } = selection;
  useEffect(() => {
    if (view.report === null) return;
    if (previousSelection.current && !selected && search.repository) {
      clearSelection();
      listRef.current?.focus({ preventScroll: true });
    }
    previousSelection.current = selected;
  }, [selected, clearSelection, search.repository, view.report]);
  const closeDetail = () => {
    selection.clear();
    if (selected) focusTriageRowSoon(selected);
  };
  useEscapeLeavesFieldFirst(selected !== undefined);
  useEscapeToGoBack(selected ? closeDetail : undefined);
  return (
    <TriageLayout
      listRef={listRef}
      view={{ ...view, refreshFromGitHub: refreshEverything }}
      selection={selection}
      detail={
        selected ? (
          <TriageDetailPane
            key={`${selected.key.repository}#${selected.key.number}`}
            pullRequest={selected}
            triageEnvironmentId={environmentId}
            refreshToken={detailRefreshToken}
            onClose={closeDetail}
            onPullRequestChanged={() => void view.refreshFromGitHub()}
          />
        ) : null
      }
    />
  );
}

function TriageWithoutEnvironment({ selection }: { selection: TriageSelection }) {
  useEscapeToGoBack();
  return <TriageLayout view={null} selection={selection} detail={null} />;
}

export function TriagePage() {
  const selection = useTriageSelection();
  const hydration = useClientSettingsHydrationStatus();
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const loadPreferences = useCallback(() => {
    void ensureClientSettingsHydrated().catch((failure) => {
      setHydrationError(
        failure instanceof Error ? failure.message : "Could not load local triage preferences.",
      );
    });
  }, []);
  useEffect(loadPreferences, [loadPreferences]);
  const environmentId = useTriageEnvironmentId();
  if (hydration !== "ready")
    return (
      <TriageLayout
        view={null}
        selection={selection}
        detail={null}
        preferencesNotice={
          hydration === "failed" ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorLine message={hydrationError ?? "Could not load local triage preferences."} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setHydrationError(null);
                  loadPreferences();
                }}
              >
                Retry preferences
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading triage preferences…</p>
          )
        }
      />
    );
  return environmentId === null ? (
    <TriageWithoutEnvironment selection={selection} />
  ) : (
    <TriageEnvironmentPage
      key={environmentId}
      environmentId={environmentId}
      selection={selection}
    />
  );
}
