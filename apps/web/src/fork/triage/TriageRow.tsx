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

type BadgeVariant = "error" | "warning" | "success" | "info" | "outline";

const STATUS_PRESENTATION: Record<TriageStatus, { label: string; variant: BadgeVariant }> = {
  blocked: { label: "Blocked", variant: "error" },
  "changes-requested": { label: "Changes requested", variant: "warning" },
  "ready-to-merge": { label: "Ready to merge", variant: "success" },
  "waiting-ci-authorization": { label: "Awaiting CI authorization", variant: "info" },
  "waiting-ci": { label: "Waiting on CI", variant: "info" },
  "ready-for-review": { label: "Ready for review", variant: "outline" },
  draft: { label: "Draft", variant: "outline" },
};

const REFINEMENT_LADDER: ReadonlyArray<{ level: TriageRefinement; label: string }> = [
  { level: "raw", label: "Raw" },
  { level: "self-reviewed", label: "Self-reviewed" },
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

function plural(count: number, noun: string): string {
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

function RefinementLadder({ refinement }: { refinement: TriageRefinement }) {
  const reached = REFINEMENT_LADDER.findIndex((step) => step.level === refinement);
  const current = REFINEMENT_LADDER[reached];
  return (
    <WithTooltip tip={`Refinement: ${current?.label ?? refinement}`}>
      <span
        role="img"
        aria-label={`Refinement: ${current?.label ?? refinement}`}
        className="flex gap-0.5"
      >
        {REFINEMENT_LADDER.map((step, index) => (
          <span
            key={step.level}
            className={cn(
              "h-1.5 w-3 rounded-full",
              index <= reached ? "bg-foreground/70" : "bg-foreground/15",
            )}
          />
        ))}
      </span>
    </WithTooltip>
  );
}

function CiSignal({ ci }: { ci: TriagePullRequest["ci"] }) {
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

export function TriageRow({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const status = STATUS_PRESENTATION[pullRequest.status];
  const { repository, number } = pullRequest.key;
  return (
    <li className="flex flex-col gap-1 px-2 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <a
          href={pullRequest.url}
          rel="noreferrer noopener"
          target="_blank"
          className="min-w-0 truncate text-sm hover:underline"
        >
          {pullRequest.title}
        </a>
        <span className="min-w-0 shrink-[2] truncate font-mono text-xs text-muted-foreground tabular-nums">
          {repository}#{number}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <RefinementLadder refinement={pullRequest.refinement} />
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-sm font-semibold">{pullRequest.nextAction}</span>
        <Signals pullRequest={pullRequest} />
      </span>
    </li>
  );
}
