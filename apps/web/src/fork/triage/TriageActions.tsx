import type { TriagePullRequest } from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { readLocalApi } from "~/localApi";

export function TriageActions({
  pullRequest,
  children,
}: {
  pullRequest: TriagePullRequest;
  children?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Pull request actions"
      className="flex flex-wrap items-center gap-2"
    >
      <Button
        size="sm"
        variant="outline"
        onClick={() => void readLocalApi()?.shell.openExternal(pullRequest.url)}
      >
        <ArrowUpRightIcon aria-hidden />
        Open on GitHub
      </Button>
      {children}
    </div>
  );
}
