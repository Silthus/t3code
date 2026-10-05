import type {
  TriageCiState,
  TriagePullRequest,
  TriageRefinement,
  TriageStatus,
} from "@t3tools/contracts";
import {
  BotIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  MessageSquareIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useClientSettings } from "~/hooks/useSettings";
import { effectiveTriageActions } from "./grouping.logic";
import { triageSummary } from "./slack.logic";
import { TriageCopySlack } from "./TriageCopySlack";
import { TriageLinkedThreads } from "./TriageLinkedThreads";
import { TriageRiskRow } from "./TriageRisk";

type BadgeVariant = "error" | "warning" | "success" | "info" | "outline";

const STATUS_PRESENTATION: Record<TriageStatus, { label: string; variant: BadgeVariant }> = {
  blocked: { label: "Blocked", variant: "error" },
  "changes-requested": { label: "Changes requested", variant: "warning" },
  "waiting-merge": { label: "Waiting in merge queue", variant: "info" },
  "ready-to-merge": { label: "Ready to merge", variant: "success" },
  "waiting-ci-authorization": { label: "Awaiting CI authorization", variant: "info" },
  "waiting-ci": { label: "Waiting on CI", variant: "info" },
  "ready-for-review": { label: "Waiting for review", variant: "outline" },
  draft: { label: "Draft", variant: "outline" },
};

const REFINEMENT_LADDER: ReadonlyArray<{ level: TriageRefinement; label: string }> = [
  { level: "raw", label: "Raw" },
  { level: "self-reviewed", label: "Bot-reviewed" },
  { level: "human-reviewed", label: "Human-reviewed" },
  { level: "approved", label: "Approved" },
];

const CI_PRESENTATION: Record<
  Exclude<TriageCiState, "none">,
  { label: string; Icon: LucideIcon; toneClassName: string }
> = {
  green: {
    label: "CI green",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  failing: { label: "CI failing", Icon: CircleXIcon, toneClassName: "text-destructive" },
  pending: {
    label: "CI running",
    Icon: CircleDotIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
  "awaiting-authorization": {
    label: "CI awaiting authorization",
    Icon: ShieldQuestionIcon,
    toneClassName: "text-info-foreground",
  },
  cancelled: {
    label: "CI cancelled",
    Icon: CircleSlashIcon,
    toneClassName: "text-muted-foreground",
  },
};

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function botFindingsLabel(counts: TriagePullRequest["counts"]): string {
  return counts.botFindingsOpen > 0
    ? plural(counts.botFindingsOpen, "finding")
    : plural(counts.botFindingsResolved, "resolved finding");
}

function WithTooltip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1" />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  );
}

export function refinementLabel(refinement: TriageRefinement): string {
  return REFINEMENT_LADDER.find((step) => step.level === refinement)?.label ?? refinement;
}

export function RefinementLadder({
  refinement,
  evidence,
}: {
  refinement: TriageRefinement;
  evidence?: string | undefined;
}) {
  return (
    <WithTooltip tip={evidence ?? `Refinement: ${refinementLabel(refinement)}`}>
      <span className="text-xs text-muted-foreground">{refinementLabel(refinement)}</span>
    </WithTooltip>
  );
}

export function TriagePendingWork({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const { triagePreferences } = useClientSettings();
  const actions = effectiveTriageActions(pullRequest, triagePreferences);
  return (
    <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {actions.map((action) => (
        <span key={action.kind} className="break-words">
          {action.owner === "author" ? "Me" : "Team"}: {action.label}
        </span>
      ))}
      {(pullRequest.waiting ?? []).map((state) => (
        <span key={state}>{state}</span>
      ))}
    </span>
  );
}

export function CiSignal({ ci }: { ci: TriagePullRequest["ci"] }) {
  if (ci.state === "none") return null;
  const presentation = CI_PRESENTATION[ci.state];
  const tip =
    ci.failing.length > 0 ? `${presentation.label}: ${ci.failing.join(", ")}` : presentation.label;
  return (
    <WithTooltip tip={tip}>
      <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
      <span>{presentation.label}</span>
    </WithTooltip>
  );
}

function Signals({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const { counts, mergeable } = pullRequest;
  const truncated = counts.threadsTruncated ? " (more threads than GitHub listed)" : "";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <CiSignal ci={pullRequest.ci} />
      {mergeable === "CONFLICTING" ? (
        <span className="inline-flex items-center gap-1 text-destructive">
          <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
          Conflicts
        </span>
      ) : null}
      {counts.humanThreadsAwaiting > 0 ? (
        <WithTooltip tip={`Human review threads waiting on your reply${truncated}`}>
          <MessageSquareIcon aria-hidden className="size-3.5" />
          {plural(counts.humanThreadsAwaiting, "thread")}
        </WithTooltip>
      ) : null}
      {counts.botFindingsOpen > 0 || counts.botFindingsResolved > 0 ? (
        <WithTooltip
          tip={`${counts.botFindingsOpen} open, ${counts.botFindingsResolved} resolved bot findings${truncated}`}
        >
          <BotIcon aria-hidden className="size-3.5" />
          {botFindingsLabel(counts)}
        </WithTooltip>
      ) : null}
    </span>
  );
}

function rowId({ key }: Pick<TriagePullRequest, "key">): string {
  return `${key.repository}#${key.number}`;
}

export function focusTriageRowSoon(pullRequest: Pick<TriagePullRequest, "key">) {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLButtonElement>(`[data-triage-row="${CSS.escape(rowId(pullRequest))}"]`)
      ?.focus();
  });
}

export function StatusBadge({ status }: { status: TriageStatus }) {
  const presentation = STATUS_PRESENTATION[status];
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

export function TriageRow({
  pullRequest,
  selected,
  onSelect,
}: {
  pullRequest: TriagePullRequest;
  selected: boolean;
  onSelect: (pullRequest: TriagePullRequest) => void;
}) {
  const { repository, number } = pullRequest.key;
  return (
    <li className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-triage-row={rowId(pullRequest)}
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(pullRequest)}
          className={cn(
            "flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            selected ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate text-sm" />}>
                {pullRequest.title}
              </TooltipTrigger>
              <TooltipPopup side="top">{pullRequest.title}</TooltipPopup>
            </Tooltip>
            <span className="min-w-0 shrink-[2] truncate font-mono text-xs text-muted-foreground tabular-nums">
              {repository}#{number}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-2">
              <StatusBadge status={pullRequest.status} />
              <RefinementLadder
                refinement={pullRequest.refinement}
                evidence={pullRequest.refinementEvidence}
              />
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="line-clamp-2 text-sm break-words">{triageSummary(pullRequest)}</span>
            <Signals pullRequest={pullRequest} />
          </span>
          {pullRequest.blockers.length > 0 ? (
            <span className="text-xs break-words text-destructive">
              {pullRequest.blockers.join(" · ")}
            </span>
          ) : null}
          <TriagePendingWork pullRequest={pullRequest} />
        </button>
        <span className="shrink-0 text-xs text-muted-foreground">
          <TriageRiskRow pullRequest={pullRequest} />
        </span>
      </div>
      <div className="px-2">
        <TriageCopySlack pullRequests={[pullRequest]} />
      </div>
      <TriageLinkedThreads pullRequest={pullRequest} />
    </li>
  );
}
