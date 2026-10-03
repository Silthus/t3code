import type { UseNavigateResult } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";

export function forkTriagePaletteItem(
  navigate: UseNavigateResult<string>,
): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:fork-triage",
    searchTerms: ["triage", "my prs", "review", "next action"],
    title: "Open PR triage",
    icon: <ListChecksIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/triage" });
    },
  };
}
