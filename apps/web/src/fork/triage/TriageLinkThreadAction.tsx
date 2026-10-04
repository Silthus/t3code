import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import type { EnvironmentId, TriagePullRequest } from "@t3tools/contracts";
import { useState } from "react";

import { PullRequestThreadLinks } from "~/components/pullRequest/PullRequestThreadLinks";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
} from "~/lib/openPullRequestLink";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";

export function TriageLinkThreadAction({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const [pickerEnvironmentId, setPickerEnvironmentId] = useState<EnvironmentId | null>(null);
  const targets = connectedIds.flatMap((environmentId) => {
    const mode = threadPullRequestLinkMode(configs.get(environmentId)?.environment.capabilities);
    if (mode === "unsupported") return [];
    const environmentProjects = projects.filter(
      (project) => project.environmentId === environmentId,
    );
    const project = (
      mode === "multiple" ? findProjectOnChangeRequestHost : findProjectForChangeRequest
    )(environmentProjects, pullRequest.key);
    return project === undefined
      ? []
      : [{ environmentId, reference: { projectId: project.id, ...pullRequest.key } }];
  });
  const selected = targets.find((target) => target.environmentId === pickerEnvironmentId);
  const trigger = (
    <Button size="sm" variant="outline" disabled={targets.length === 0}>
      Link thread
    </Button>
  );
  return (
    <>
      {targets.length > 1 ? (
        <Menu>
          <MenuTrigger render={trigger} />
          <MenuPopup>
            {targets.map((target) => (
              <MenuItem
                key={target.environmentId}
                onClick={() => setPickerEnvironmentId(target.environmentId)}
              >
                {environments.find(
                  (environment) => environment.environmentId === target.environmentId,
                )?.label ?? target.environmentId}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={targets.length === 0}
          onClick={() => setPickerEnvironmentId(targets[0]?.environmentId ?? null)}
        >
          Link thread
        </Button>
      )}
      {selected ? (
        <PullRequestThreadLinks
          environmentId={selected.environmentId}
          reference={selected.reference}
          url={pullRequest.url}
          threadRef={null}
          display="picker"
          onPickerOpenChange={(open) => {
            if (!open) setPickerEnvironmentId(null);
          }}
        />
      ) : null}
    </>
  );
}
