import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { TriagePullRequest } from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  legacyThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";
import { EllipsisIcon, MessageSquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useConnectedEnvironmentIds, useEnvironment } from "~/state/environments";
import { environmentServerConfigsAtom } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";

import { linkedThreadsByPullRequest, type TriageLinkedThread } from "./linkedThreads.logic";

const linkedThreadsAtom = Atom.make((get) => {
  const shells = get(environmentThreadShells.threadShellsAtom);
  const keys = shells.flatMap((shell) => [
    ...visibleThreadPullRequests(shell.pullRequests),
    ...(shell.branchPullRequest == null
      ? []
      : [legacyThreadPullRequestKey(shell.branchPullRequest)]),
  ]);
  const configs = get(environmentServerConfigsAtom);
  return linkedThreadsByPullRequest(
    shells,
    keys,
    new Map([...configs].map(([id, config]) => [id, config.environment.capabilities])),
  );
});

function LinkedThreadChip({
  thread,
  url,
  showEnvironment,
}: {
  thread: TriageLinkedThread;
  url: string;
  showEnvironment: boolean;
}) {
  const environment = useEnvironment(thread.environmentId);
  const linking = usePullRequestLinking(thread.environmentId);
  const [pending, setPending] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const title = thread.title || "Untitled thread";
  const threadRef = scopeThreadRef(thread.environmentId, thread.threadId);
  const unlink = async () => {
    if (pending) return;
    setPending(true);
    const focusTarget =
      chipRef.current?.closest("li")?.querySelector<HTMLButtonElement>("[data-triage-row]") ??
      chipRef.current
        ?.closest("section")
        ?.querySelector<HTMLButtonElement>('[aria-label="Close pull request detail"]');
    try {
      await linking.changeLink(threadRef, url, false);
      focusTarget?.focus({ preventScroll: true });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not unlink the thread",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <span
      ref={chipRef}
      className="inline-flex min-w-0 max-w-full items-center rounded-md border border-border"
    >
      <Button
        size="micro"
        variant="ghost"
        render={<Link to="/$environmentId/$threadId" params={buildThreadRouteParams(threadRef)} />}
        title={title}
      >
        <MessageSquareIcon aria-hidden />
        <span className="max-w-48 truncate">{title}</span>
        {showEnvironment ? (
          <span className="max-w-24 truncate text-muted-foreground">
            {environment?.label ?? thread.environmentId}
          </span>
        ) : null}
        {thread.archivedAt !== null ? (
          <span className="text-muted-foreground">Archived</span>
        ) : null}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={`Actions for ${title}`}
              disabled={pending}
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup>
          <MenuItem disabled={pending} onClick={() => void unlink()}>
            Unlink
          </MenuItem>
        </MenuPopup>
      </Menu>
    </span>
  );
}

export function TriageLinkedThreads({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const index = useAtomValue(linkedThreadsAtom);
  const connectedIds = useConnectedEnvironmentIds();
  const key = threadPullRequestKeyOf(pullRequest.key);
  const threads = index.threadsByPullRequest.get(key) ?? [];
  const upgrades = index.upgradeEnvironmentsByPullRequest.get(key) ?? [];
  if (threads.length === 0 && upgrades.length === 0) return null;
  return (
    <div aria-label="Linked threads" className="flex min-w-0 flex-wrap gap-1 px-2 py-1">
      {upgrades.map((environmentId) => (
        <BranchUpgradeNotice key={environmentId} environmentId={environmentId} />
      ))}
      {threads.map((thread) => (
        <LinkedThreadChip
          key={`${thread.environmentId}:${thread.threadId}`}
          thread={thread}
          url={pullRequest.url}
          showEnvironment={connectedIds.length > 1}
        />
      ))}
    </div>
  );
}

function BranchUpgradeNotice({
  environmentId,
}: {
  environmentId: TriageLinkedThread["environmentId"];
}) {
  const environment = useEnvironment(environmentId);
  return (
    <span className="text-xs text-muted-foreground">
      Upgrade {environment?.label ?? environmentId} to manage branch-linked threads.
    </span>
  );
}
