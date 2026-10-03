import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { TriagePullRequest } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";

import { presetPrompt, type TriageThreadPreset } from "./newThreadPresets";
import { pickProjectForPullRequest } from "./projectMatch.logic";
import { useTriageEnvironmentId } from "./state";
import { useStartTriageThread } from "./useStartTriageThread";

const PRESETS = [
  ["babysit", "Babysit"],
  ["review-comments", "Address review comments"],
  ["fix-ci", "Fix CI"],
  ["modernize", "Modernize / resolve conflicts"],
  ["qa-swarm", "QA swarm"],
  ["custom", "Custom instruction"],
] as const satisfies ReadonlyArray<readonly [TriageThreadPreset, string]>;

export function TriageNewThreadMenu({ pullRequest }: { pullRequest: TriagePullRequest }) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const triageEnvironmentId = useTriageEnvironmentId();
  const availableProjects = projects.filter(
    (project) =>
      connectedIds.includes(project.environmentId) &&
      configs.get(project.environmentId)?.environment.capabilities.pullRequests === true,
  );
  const match = pickProjectForPullRequest(availableProjects, pullRequest, triageEnvironmentId);
  const matchedProject =
    availableProjects.find(
      (project) =>
        project.environmentId === match?.environmentId && project.id === match.reference.projectId,
    ) ?? null;
  const [preset, setPreset] = useState<TriageThreadPreset | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const targetProject =
    matchedProject ??
    availableProjects.find(
      (project) =>
        scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }) ===
        projectKey,
    ) ??
    null;
  const { start, preparing } = useStartTriageThread(targetProject);
  const fieldId = useId();
  const canStart = targetProject !== null && (preset !== "custom" || instruction.trim().length > 0);
  const openPreset = (choice: TriageThreadPreset) => {
    if (choice !== "custom" && matchedProject !== null) {
      void start(pullRequest.url, presetPrompt(choice, pullRequest));
    } else {
      setPreset(choice);
      setProjectKey(null);
      setInstruction("");
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger disabled={preparing} render={<Button size="sm" variant="outline" />}>
          {preparing ? "Preparing draft..." : "New thread"}
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start">
          {PRESETS.map(([choice, label]) => (
            <MenuItem key={choice} onClick={() => openPreset(choice)}>
              {label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Dialog
        open={preset !== null}
        onOpenChange={(open) => {
          if (!open) setPreset(null);
        }}
      >
        <DialogPopup>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (preset === null || !canStart || preparing) return;
              const prompt = presetPrompt(preset, pullRequest, instruction.trim());
              setPreset(null);
              void start(pullRequest.url, prompt);
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {PRESETS.find(([choice]) => choice === preset)?.[1] ?? "New thread"}
              </DialogTitle>
              <DialogDescription>
                Open an unsent draft for {pullRequest.key.repository}#{pullRequest.key.number} in a
                PR worktree.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                {matchedProject === null ? (
                  <div className="flex flex-col gap-2">
                    <Label id={`${fieldId}-project`}>Project</Label>
                    <Select value={projectKey} onValueChange={setProjectKey}>
                      <SelectTrigger aria-labelledby={`${fieldId}-project`}>
                        <SelectValue placeholder="Choose a project" />
                      </SelectTrigger>
                      <SelectPopup>
                        {environments.map((environment) => {
                          const members = availableProjects.filter(
                            (project) => project.environmentId === environment.environmentId,
                          );
                          if (members.length === 0) return null;
                          return (
                            <SelectGroup key={environment.environmentId}>
                              <SelectGroupLabel>{environment.label}</SelectGroupLabel>
                              {members.map((project) => (
                                <SelectItem
                                  key={project.id}
                                  value={scopedProjectKey({
                                    environmentId: project.environmentId,
                                    projectId: project.id,
                                  })}
                                >
                                  <span className="block break-words">{project.title}</span>
                                  <span className="block break-all text-xs text-muted-foreground">
                                    {project.workspaceRoot}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          );
                        })}
                      </SelectPopup>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      {availableProjects.length === 0
                        ? "Connect an environment with pull request support and add a project to start a draft."
                        : "No matching repository was found. Choose a project from a connected environment."}
                    </p>
                  </div>
                ) : (
                  <p className="break-all text-sm text-muted-foreground">
                    Project: {matchedProject.title}
                  </p>
                )}
                {preset === "custom" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={`${fieldId}-instruction`}>Instruction</Label>
                    <Textarea
                      id={`${fieldId}-instruction`}
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value)}
                      required
                    />
                  </div>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPreset(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canStart || preparing}>
                Open draft
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
