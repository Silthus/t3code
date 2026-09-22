import { createFileRoute } from "@tanstack/react-router";

import { TriageDashboard } from "../fork/triage/TriageDashboard";

export const Route = createFileRoute("/_chat/triage")({
  component: TriageDashboard,
});
