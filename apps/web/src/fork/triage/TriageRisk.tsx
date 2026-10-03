import type { EnvironmentId, TriagePullRequest, TriageRisk } from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatEnvironmentQueryError } from "~/state/query";

import { useAssessTriage, useReloadTriage } from "./state";

const TONES = { low: "success", medium: "warning", high: "error" } as const;
const LABELS: Record<TriageRisk, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

function RiskBadge({ risk, reason }: { risk: TriageRisk; reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <Badge variant={TONES[risk]}>{LABELS[risk]}</Badge>
      </TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}

function AssessButton({
  pullRequest,
  environmentId,
}: {
  pullRequest: TriagePullRequest;
  environmentId: EnvironmentId;
}) {
  const { assess } = useAssessTriage();
  const reload = useReloadTriage(environmentId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = pullRequest.judgement._tag === "pending";
  return (
    <span className="inline-flex max-w-40 flex-wrap items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        disabled={pending || submitting}
        onClick={async (event) => {
          event.stopPropagation();
          setSubmitting(true);
          setError(null);
          try {
            const result = await assess({ environmentId, input: pullRequest.key });
            if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
            else if (result.value._tag === "failed" || result.value._tag === "unavailable")
              setError(result.value.reason);
            reload();
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {pending || submitting
          ? "Assessing…"
          : pullRequest.judgement._tag === "ready"
            ? "Re-assess"
            : "Assess"}
      </Button>
      {error ? (
        <span role="alert" className="min-w-0 break-words text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function TriageRiskRow({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const { environmentId } = useAssessTriage();
  const state = pullRequest.judgement;
  if (state._tag === "ready")
    return <RiskBadge risk={state.judgement.risk} reason={state.judgement.riskReason} />;
  if (state._tag === "not-requested" && environmentId !== null)
    return <AssessButton pullRequest={pullRequest} environmentId={environmentId} />;
  if (state._tag === "pending") return <span aria-label="Risk assessment pending">Assessing…</span>;
  if (state._tag === "failed" || state._tag === "unavailable")
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>Risk {state._tag}</TooltipTrigger>
        <TooltipPopup>{state.reason}</TooltipPopup>
      </Tooltip>
    );
  return null;
}

export function TriageRiskDetail({
  pullRequest,
  environmentId,
}: {
  pullRequest: TriagePullRequest;
  environmentId: EnvironmentId;
}) {
  const state = pullRequest.judgement;
  return (
    <section aria-label="Risk judgement" className="flex flex-col gap-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Risk judgement</h3>
        <AssessButton pullRequest={pullRequest} environmentId={environmentId} />
      </div>
      {state._tag === "ready" ? (
        <>
          <p>{state.judgement.summary}</p>
          <span>
            <RiskBadge risk={state.judgement.risk} reason={state.judgement.riskReason} />
          </span>
          <p>{state.judgement.riskReason}</p>
          <p className="text-xs text-muted-foreground">
            Based on {state.judgement.basis} · head {state.judgement.headSha.slice(0, 8)}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          {state._tag === "not-requested"
            ? "Drafts are assessed only when you ask."
            : state._tag === "pending"
              ? "Assessment queued or running."
              : state.reason}
        </p>
      )}
    </section>
  );
}
