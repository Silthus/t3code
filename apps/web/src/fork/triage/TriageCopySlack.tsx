import type { TriagePullRequest } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { serializeTriageSlack } from "./slack.logic";

export function TriageCopySlack({
  pullRequests,
  teamQueue = false,
}: {
  pullRequests: ReadonlyArray<TriagePullRequest>;
  teamQueue?: boolean;
}) {
  const { triagePreferences } = useClientSettings();
  const message = serializeTriageSlack(pullRequests, triagePreferences);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Slack message",
    extraFlavors: { "text/html": message.html },
    onCopy: () => setError(null),
    onError: (failure) => setError(failure.message),
  });
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <Button
        size="xs"
        variant="ghost"
        disabled={!message.text}
        title={
          message.text ? "Copies a message without sending it" : "No pending team action to copy"
        }
        onClick={() => {
          setError(null);
          copyToClipboard(message.text);
        }}
      >
        {isCopied ? "Copied" : teamQueue ? "Copy team queue Slack message" : "Copy Slack message"}
      </Button>
      {error ? (
        <span role="alert" className="break-words text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
