import { createFileRoute } from "@tanstack/react-router";

import { TriagePage, type TriageSearch } from "../fork/triage/TriagePage";

export const Route = createFileRoute("/_chat/triage")({
  validateSearch: (raw: Record<string, unknown>): TriageSearch =>
    typeof raw.repository === "string" &&
    raw.repository.length > 0 &&
    typeof raw.number === "number" &&
    Number.isInteger(raw.number) &&
    raw.number > 0
      ? { repository: raw.repository.slice(0, 200), number: raw.number }
      : {},
  component: TriagePage,
});
