import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ForkTriageItem } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon, MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "~/components/pullRequest/PullRequestListRow";
import { PullRequestSearchInput } from "~/components/pullRequest/PullRequestListFilters";
import { PullRequestRow, type PullRequestRowTarget } from "~/components/pullRequest/PullRequestRow";
import type { EnvironmentPullRequestEntry } from "~/components/pullRequest/pullRequestList.logic";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { usePullRequestList } from "~/state/pullRequests";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  blockerSummary,
  filterTriageItems,
  groupTriageItems,
  toTriageMarkdown,
  triageScopes,
} from "./presentation";
import { readTriageReports, refreshTriageReports, useTriageReports } from "./state";

interface EnvironmentTriageItem extends ForkTriageItem {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

type TriageSort = "priority" | "recent" | "repository";

type ChildProgress = {
  readonly total: number;
  readonly closed: number;
  readonly complete?: boolean;
};

function canonicalPullRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().toLocaleLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLocaleLowerCase();
  }
}

function formatScanTime(value: string | null): string {
  if (value === null) return "Not scanned yet";
  const time = Date.parse(value);
  return Number.isNaN(time)
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(time);
}

function freshnessLabel(item: ForkTriageItem): string {
  return item.lastSuccessfulRefresh
    ? `Evidence refreshed ${formatRelativeTimeLabel(item.lastSuccessfulRefresh)}`
    : "Evidence refresh time unknown";
}

function childProgress(value: unknown): ChildProgress | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("total" in value) ||
    !("closed" in value) ||
    typeof value.total !== "number" ||
    typeof value.closed !== "number"
  )
    return null;
  return {
    total: value.total,
    closed: value.closed,
    ...("complete" in value && typeof value.complete === "boolean"
      ? { complete: value.complete }
      : {}),
  };
}

function threadForItem(item: EnvironmentTriageItem, threads: ReturnType<typeof useThreadShells>) {
  const itemUrl = canonicalPullRequestUrl(item.url);
  return threads.find(
    (thread) =>
      thread.environmentId === item.environmentId &&
      (thread.pullRequests.some((link) => canonicalPullRequestUrl(link.url) === itemUrl) ||
        canonicalPullRequestUrl(thread.linkedPullRequest?.url ?? "") === itemUrl ||
        canonicalPullRequestUrl(thread.branchPullRequest?.url ?? "") === itemUrl),
  );
}

function TriageEvidence({ item }: { readonly item: ForkTriageItem }) {
  const [open, setOpen] = useState(false);
  const progress = childProgress(item.details?.childProgress);
  const evidence = item.evidence
    .toSorted((left, right) => (right.at ?? "").localeCompare(left.at ?? ""))
    .slice(0, 40);
  const omittedEvidenceCount = item.evidence.length - evidence.length;
  return (
    <details
      className="px-3 pb-2 pl-9 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        Details ({item.blockers.length} blockers, {item.evidence.length} evidence)
      </summary>
      {open ? (
        <div className="mt-2 space-y-2 border-l pl-3">
          {item.blockers.map((blocker) => (
            <p key={`${blocker.code}:${blocker.label}`}>
              {blocker.label}
              {blocker.actor ? ` Next: ${blocker.actor}.` : ""}{" "}
              {blocker.evidenceUrls.map((url) => (
                <a className="underline" key={url} href={url} rel="noreferrer" target="_blank">
                  Source{" "}
                </a>
              ))}
            </p>
          ))}
          {item.relations.map((relation) => (
            <p key={`${relation.kind}:${relation.target}:${relation.source}`}>
              {relation.kind.replaceAll("-", " ")}:{" "}
              <a className="underline" href={relation.evidenceUrl} rel="noreferrer" target="_blank">
                {relation.target}
              </a>{" "}
              ({relation.certainty})
            </p>
          ))}
          {item.kind === "issue" && progress && progress.total > 0 ? (
            <p>
              Child issues: {progress.closed} of {progress.total} closed.
              {progress.complete === false
                ? " Some child evidence is missing."
                : " Closure does not confirm shipment."}
            </p>
          ) : null}
          {typeof item.details?.nextUnresolvedDependency === "string" ? (
            <p>
              Next unresolved item:{" "}
              <a
                className="underline"
                href={item.details.nextUnresolvedDependency}
                rel="noreferrer"
                target="_blank"
              >
                {item.details.nextUnresolvedDependency}
              </a>
            </p>
          ) : null}
          {item.kind === "issue" && typeof item.details?.workerExecution === "string" ? (
            <p>{item.details.workerExecution}</p>
          ) : null}
          {item.errors.map((error) => (
            <p key={`${error.code}:${error.at}`}>{error.message}</p>
          ))}
          {item.judgments.map((judgment) => (
            <p key={judgment.id}>
              {judgment.label}:{" "}
              {typeof judgment.value === "string" ? judgment.value : JSON.stringify(judgment.value)}{" "}
              ({judgment.certainty}
              {judgment.confidence === null ? "" : `, confidence ${judgment.confidence.toFixed(2)}`}
              )
            </p>
          ))}
          {evidence.map((evidence) => (
            <p key={evidence.sourceId} className="break-words">
              <a
                className="underline"
                href={evidence.url || item.url}
                rel="noreferrer"
                target="_blank"
              >
                {evidence.author ?? evidence.sourceId}
              </a>
              {evidence.at ? ` · ${formatScanTime(evidence.at)}` : ""}
              <br />
              {evidence.excerpt}
            </p>
          ))}
          {omittedEvidenceCount > 0 ? (
            <p>
              {omittedEvidenceCount} evidence{" "}
              {omittedEvidenceCount === 1 ? "entry is" : "entries are"} omitted.{" "}
              <a className="underline" href={item.url} rel="noreferrer" target="_blank">
                View on GitHub
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function UnmatchedTriageRow({
  item,
  onOpenPullRequest,
}: {
  readonly item: EnvironmentTriageItem;
  readonly onOpenPullRequest: (event: MouseEvent<HTMLButtonElement>) => boolean;
}) {
  const state =
    item.lifecycle === "merged" ? "merged" : item.lifecycle === "closed" ? "closed" : "open";
  return (
    <button
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "cursor-pointer px-3 py-2.5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      onClick={(event) => {
        if (!onOpenPullRequest(event)) window.open(item.url, "_blank", "noopener,noreferrer");
      }}
      type="button"
    >
      <PullRequestRowGlyph
        className="mt-0.75 self-start"
        isDraft={item.lifecycle === "draft"}
        state={state}
      />
      <PullRequestRowLines
        meta={
          <span className="truncate">
            {item.repo} ·{" "}
            {item.kind === "issue" ? "Issue link" : "Pull request list metadata unavailable"}
          </span>
        }
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{item.number}</span>}
        title={item.title}
        updatedAt={typeof item.details?.updatedAt === "string" ? item.details.updatedAt : null}
      />
    </button>
  );
}

function TriageItemRow({
  item,
  changed,
  entry,
  thread,
  onSelect,
  onOpenThread,
  onOpenPullRequest,
}: {
  readonly item: EnvironmentTriageItem;
  readonly changed: boolean;
  readonly entry: EnvironmentPullRequestEntry | undefined;
  readonly thread: ReturnType<typeof threadForItem>;
  readonly onSelect: (entry: PullRequestRowTarget) => void;
  readonly onOpenThread: () => void;
  readonly onOpenPullRequest: (event: MouseEvent<HTMLButtonElement>) => boolean;
}) {
  // The feed's green aggregate can omit workflows that still need authorization.
  const rowEntry = entry
    ? { ...entry, checksState: undefined, reviewDecision: undefined }
    : undefined;
  return (
    <article className="border-b last:border-b-0">
      {rowEntry ? (
        <PullRequestRow
          entry={rowEntry}
          onSelect={onSelect}
          selected={false}
          showProjectTitle
          showProvider={false}
        />
      ) : (
        <UnmatchedTriageRow item={item} onOpenPullRequest={onOpenPullRequest} />
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 pl-9 text-xs text-muted-foreground">
        {changed ? <span className="text-primary">Changed this scan</span> : null}
        <span className="min-w-0 truncate">{blockerSummary(item)}</span>
        {item.nextActors.length > 0 ? <span>Next: {item.nextActors.join(", ")}</span> : null}
        <span>{item.certainty}</span>
        <span>{freshnessLabel(item)}</span>
        {thread ? (
          <Button onClick={onOpenThread} size="xs" variant="link">
            <MessageSquareIcon />
            Thread
          </Button>
        ) : null}
        <a
          className="inline-flex items-center gap-1 underline"
          href={item.url}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon className="size-3" />
          GitHub
        </a>
      </div>
      <TriageEvidence item={item} />
    </article>
  );
}

export function TriageDashboard() {
  const navigate = useNavigate();
  const openChangeRequest = useOpenChangeRequestLink();
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const reportsAtom = useTriageReports(environmentIds);
  const result = useAtomValue(reportsAtom);
  const refreshReports = useAtomRefresh(reportsAtom);
  const reports = readTriageReports(result);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string | null>(null);
  const [sort, setSort] = useState<TriageSort>("priority");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const pullRequestTargets = useMemo(
    () =>
      environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.pullRequests)
        .map((environment) => ({
          environmentId: environment.environmentId,
          input: { state: "all" as const, involvement: "authored" as const, limit: 99 },
        })),
    [environments],
  );
  const pullRequestList = usePullRequestList(pullRequestTargets);
  const entriesByUrl = useMemo(() => {
    const entries = new Map<string, EnvironmentPullRequestEntry>();
    for (const entry of pullRequestList.data?.entries ?? []) {
      entries.set(`${entry.environmentId}:${canonicalPullRequestUrl(entry.url)}`, entry);
    }
    return entries;
  }, [pullRequestList.data?.entries]);
  const items = reports.flatMap((entry): ReadonlyArray<EnvironmentTriageItem> => {
    const environment = environments.find((value) => value.environmentId === entry.environmentId);
    return (entry.report?.items ?? []).map((item) => ({
      ...item,
      environmentId: entry.environmentId,
      environmentLabel: environment?.label ?? entry.environmentId,
    }));
  });
  const visibleItems = filterTriageItems(items, { query, scope });
  const changedItems = new Set(
    reports.flatMap((entry) =>
      (entry.report?.changes ?? []).map((change) => `${entry.environmentId}:${change.item}`),
    ),
  );
  const groups = groupTriageItems(visibleItems).map((group) => ({
    ...group,
    items: group.items.toSorted((left, right) => {
      if (sort === "recent") {
        return (right.lastSuccessfulRefresh ?? "").localeCompare(left.lastSuccessfulRefresh ?? "");
      }
      if (sort === "repository")
        return left.repo.localeCompare(right.repo) || left.number - right.number;
      return 0;
    }),
  }));
  const scanTimes = reports
    .flatMap((entry) => (entry.report?.lastScanAt ? [entry.report.lastScanAt] : []))
    .toSorted();
  const earliestScanAt = scanTimes.at(0) ?? null;
  const latestScanAt = scanTimes.at(-1) ?? null;
  const errors = reports.flatMap((entry) =>
    entry.error
      ? [
          `${environments.find((environment) => environment.environmentId === entry.environmentId)?.label ?? entry.environmentId}: ${entry.error}`,
        ]
      : [],
  );
  const reportErrors = reports.flatMap((entry) =>
    (entry.report?.errors ?? [])
      .filter((error) => error.code !== "inference-key-missing")
      .map((error) => error.message),
  );
  const inferenceUnavailable = reports.some((entry) =>
    entry.report?.errors.some((error) => error.code === "inference-key-missing"),
  );
  const allScopes = [
    ...new Set([
      ...reports.flatMap((entry) => triageScopes(entry.report)),
      ...items.map((item) => item.repo),
    ]),
  ].toSorted();

  const refresh = async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const result = await refreshTriageReports(environmentIds);
      if (result._tag === "Failure") setRefreshError("One or more environments rejected refresh.");
      refreshReports();
    } catch (error) {
      setRefreshError(
        error instanceof Error ? error.message : "Refresh failed. Previous evidence is retained.",
      );
    } finally {
      setIsRefreshing(false);
    }
  };
  const copy = async () => {
    try {
      await writeTextToClipboard(toTriageMarkdown(visibleItems));
      toastManager.add({ title: "Copied triage summary" });
    } catch {
      setRefreshError("Could not copy the report to your clipboard.");
    }
  };
  const selectPullRequest = (entry: PullRequestRowTarget) =>
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository: entry.repository,
        number: entry.number,
        selectedProjectId: entry.projectId,
        selectedEnvironmentId: entry.environmentId,
        selectedHost: entry.host,
      },
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">GitHub triage</span>
        <span className="text-xs text-muted-foreground">Read only</span>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4 pb-12 sm:p-6">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold">What needs attention</h1>
              <p className="text-xs text-muted-foreground">
                {earliestScanAt === null
                  ? "No successful scans yet"
                  : `Scan times: ${formatScanTime(earliestScanAt)}${latestScanAt === earliestScanAt ? "" : ` to ${formatScanTime(latestScanAt)}`}`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void copy()} size="sm" variant="outline">
                <CopyIcon />
                Copy Markdown
              </Button>
              <Button disabled={isRefreshing} onClick={() => void refresh()} size="sm">
                <RefreshCwIcon />
                {isRefreshing ? "Scanning GitHub..." : "Refresh"}
              </Button>
            </div>
          </header>
          {inferenceUnavailable ? (
            <p className="text-xs text-muted-foreground">
              GitHub facts are available. Discussion analysis needs AI_GATEWAY_API_KEY in the fork
              secrets file.
            </p>
          ) : null}
          {errors.length > 0 || reportErrors.length > 0 || refreshError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {refreshError ? <p>{refreshError}</p> : null}
              {[...errors, ...reportErrors].map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <PullRequestSearchInput
              busy={pullRequestList.isPending}
              onChange={setQuery}
              placeholder="Search pull requests and issues"
              ariaLabel="Search pull requests and issues"
              value={query}
            />
            <select
              aria-label="Repository scope"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              onChange={(event) => setScope(event.target.value || null)}
              value={scope ?? ""}
            >
              <option value="">All repositories</option>
              {allScopes.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort triage"
              className="h-9 rounded-md border bg-background px-3 text-sm"
              onChange={(event) => setSort(event.target.value as TriageSort)}
              value={sort}
            >
              <option value="priority">Triage priority</option>
              <option value="recent">Recently refreshed</option>
              <option value="repository">Repository</option>
            </select>
          </div>
          {groups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {result._tag === "Initial"
                ? "Loading triage reports..."
                : earliestScanAt === null
                  ? "Your first scan is ready to run. Select Refresh to collect GitHub evidence."
                  : "No triage items match these filters."}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.classification}>
                <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">
                  {group.label} <span className="tabular-nums">{group.items.length}</span>
                </h2>
                <div className="overflow-hidden rounded-lg border">
                  {group.items.map((item) => {
                    const thread = threadForItem(item, threads);
                    const entry = entriesByUrl.get(
                      `${item.environmentId}:${canonicalPullRequestUrl(item.url)}`,
                    );
                    return (
                      <TriageItemRow
                        entry={entry}
                        item={item}
                        changed={changedItems.has(
                          `${item.environmentId}:${item.repo}#${item.number}`,
                        )}
                        key={`${item.environmentId}:${item.url}`}
                        onOpenThread={() =>
                          thread
                            ? void navigate({
                                to: "/$environmentId/$threadId",
                                params: {
                                  environmentId: thread.environmentId,
                                  threadId: thread.id,
                                },
                              })
                            : undefined
                        }
                        onOpenPullRequest={(event) =>
                          item.kind === "pull-request" &&
                          openChangeRequest(event, item.url, undefined, item.environmentId)
                        }
                        onSelect={selectPullRequest}
                        thread={thread}
                      />
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </main>
      </ScrollArea>
    </SidebarInset>
  );
}
