import type {
  EnvironmentId,
  TriageMergeable,
  TriagePullRequest,
  TriageReviewState,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { pickProjectForPullRequest, type PullRequestPanelTarget } from "./projectMatch.logic";
import { TriageActions } from "./TriageActions";
import { CiSignal, plural, RefinementLadder, refinementLabel, StatusBadge } from "./TriageRow";

const REVIEW_LABELS: Record<TriageReviewState, string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
  none: "No review decision",
};

const MERGEABLE_LABELS: Record<TriageMergeable, string> = {
  MERGEABLE: "No conflicts",
  CONFLICTING: "Conflicts with the base branch",
  UNKNOWN: "Not computed yet",
};

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

function usePullRequestPanelTarget(
  pullRequest: TriagePullRequest,
  triageEnvironmentId: EnvironmentId,
): PullRequestPanelTarget | null {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  return useMemo(() => {
    const canReadPullRequests = (environmentId: EnvironmentId) =>
      connectedEnvironmentIds.includes(environmentId) &&
      serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
    const readableProjects = projects.filter((project) =>
      canReadPullRequests(project.environmentId),
    );
    return pickProjectForPullRequest(readableProjects, pullRequest, triageEnvironmentId);
  }, [projects, serverConfigs, connectedEnvironmentIds, pullRequest, triageEnvironmentId]);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function botFindingsFact({ botFindingsOpen, botFindingsResolved }: TriagePullRequest["counts"]) {
  return `${botFindingsOpen} open, ${botFindingsResolved} resolved`;
}

function Facts({ pullRequest }: { pullRequest: TriagePullRequest }) {
  useNowMinute();
  const { ci, counts, requestedReviewers } = pullRequest;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      <Fact label="CI">
        {ci.state === "none" ? "No checks" : <CiSignal ci={ci} />}
        {ci.failing.length > 0 ? <span className="block">{ci.failing.join(", ")}</span> : null}
      </Fact>
      <Fact label="Review">{REVIEW_LABELS[pullRequest.review]}</Fact>
      {requestedReviewers.length > 0 ? (
        <Fact label="Waiting on">{requestedReviewers.join(", ")}</Fact>
      ) : null}
      <Fact label="Merge">
        <span className={cn(pullRequest.mergeable === "CONFLICTING" && "text-destructive")}>
          {MERGEABLE_LABELS[pullRequest.mergeable]}
        </span>
      </Fact>
      <Fact label="Human threads">
        {plural(counts.humanThreadsAwaiting, "thread")} waiting on your reply
      </Fact>
      <Fact label="Bot findings">{botFindingsFact(counts)}</Fact>
      {counts.threadsTruncated ? (
        <Fact label="Threads">More threads than GitHub listed</Fact>
      ) : null}
      <Fact label="Size">
        <span className="tabular-nums">
          +{pullRequest.additions} −{pullRequest.deletions},{" "}
          {plural(pullRequest.changedFiles, "file")}
        </span>
      </Fact>
      <Fact label="Branch">
        <span className="font-mono">
          {pullRequest.headRef} into {pullRequest.baseRef}
        </span>
      </Fact>
      <Fact label="Last push">{formatRelativeTimeLabel(pullRequest.lastPushAt)}</Fact>
      <Fact label="Updated">{formatRelativeTimeLabel(pullRequest.updatedAt)}</Fact>
    </dl>
  );
}

function DetailList({
  title,
  items,
  badge,
}: {
  title: string;
  items: ReadonlyArray<string>;
  badge?: ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {title}
        {badge}
      </h3>
      <ul className="flex list-disc flex-col gap-0.5 ps-4 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function TriageHeader({
  pullRequest,
  onClose,
  headerSlot,
  actionsSlot,
  className,
}: {
  pullRequest: TriagePullRequest;
  onClose: () => void;
  headerSlot: ReactNode;
  actionsSlot: ReactNode;
  className: string;
}) {
  const { repository, number } = pullRequest.key;
  return (
    <section aria-label="Triage" className={cn("flex flex-col gap-3 p-4", className)}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold break-words">{pullRequest.title}</h2>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">
              {repository}#{number}
            </span>
            <StatusBadge status={pullRequest.status} />
            <span className="inline-flex items-center gap-1.5">
              <RefinementLadder refinement={pullRequest.refinement} />
              {refinementLabel(pullRequest.refinement)}
            </span>
          </span>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close pull request detail"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <p className="text-sm font-semibold">{pullRequest.nextAction}</p>
      <TriageActions pullRequest={pullRequest}>{actionsSlot}</TriageActions>
      {headerSlot}
      <DetailList title="Blockers" items={pullRequest.blockers} />
      <DetailList
        title="Open questions"
        items={pullRequest.openQuestions}
        badge={<Badge variant="warning">{pullRequest.openQuestions.length}</Badge>}
      />
      <DetailList title="Signals" items={pullRequest.signals} />
      <DetailList
        title="Reasons"
        items={pullRequest.reasons.filter((reason) => !pullRequest.blockers.includes(reason))}
      />
      <Facts pullRequest={pullRequest} />
    </section>
  );
}

export function TriageDetailPane({
  pullRequest,
  triageEnvironmentId,
  onClose,
  onPullRequestChanged,
  headerSlot,
  actionsSlot,
}: {
  pullRequest: TriagePullRequest;
  triageEnvironmentId: EnvironmentId;
  onClose: () => void;
  onPullRequestChanged: () => void;
  headerSlot?: ReactNode;
  actionsSlot?: ReactNode;
}) {
  const panelTarget = usePullRequestPanelTarget(pullRequest, triageEnvironmentId);
  return (
    <aside aria-label="Pull request detail" className="flex h-full min-h-0 flex-col">
      <TriageHeader
        pullRequest={pullRequest}
        onClose={onClose}
        headerSlot={headerSlot}
        actionsSlot={actionsSlot}
        className={
          panelTarget === null
            ? "min-h-0 flex-1 overflow-y-auto"
            : "max-h-[45%] shrink-0 overflow-y-auto border-b border-border"
        }
      />
      {panelTarget === null ? null : (
        <div className="min-h-0 flex-1">
          <PullRequestDetailPanel
            key={`${panelTarget.environmentId}:${panelTarget.reference.projectId}:${panelTarget.reference.repository}#${panelTarget.reference.number}`}
            environmentId={panelTarget.environmentId}
            reference={panelTarget.reference}
            shortcutsEnabled
            getShortcutContext={getShortcutContext}
            onActed={(_action, phase = "done") => {
              if (phase === "done") onPullRequestChanged();
            }}
          />
        </div>
      )}
    </aside>
  );
}
