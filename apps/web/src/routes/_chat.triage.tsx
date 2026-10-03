import { createFileRoute } from "@tanstack/react-router";

import { TriagePage } from "../fork/triage/TriagePage";
import { parseTriageSearch } from "../fork/triage/selection.logic";

export const Route = createFileRoute("/_chat/triage")({
  validateSearch: parseTriageSearch,
  component: TriagePage,
});
