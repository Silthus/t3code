import { createFileRoute } from "@tanstack/react-router";

import { TriagePage } from "../fork/triage/TriagePage";

export const Route = createFileRoute("/_chat/triage")({
  component: TriagePage,
});
