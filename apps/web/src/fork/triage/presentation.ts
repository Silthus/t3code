import type { ForkTriageItem, ForkTriageReport } from "@t3tools/contracts";

export const TRIAGE_GROUPS = [
  ["ready-maintainer", "Ready for maintainer merge"],
  ["review", "Ready for review"],
  ["draft", "Drafts"],
  ["blocked", "Blocked"],
  ["unknown", "Uncertain"],
  ["stale-closed", "Closed as stale"],
  ["replaced", "Shipped through a replacement"],
  ["closed", "Closed pull requests"],
  ["merged", "Merged pull requests"],
  ["issue", "Issue progress"],
] as const;

export function filterTriageItems<Item extends ForkTriageItem>(
  items: ReadonlyArray<Item>,
  filters: { readonly query: string; readonly scope: string | null },
): ReadonlyArray<Item> {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.scope !== null && item.repo !== filters.scope) return false;
    if (query.length === 0) return true;
    return [
      item.repo,
      String(item.number),
      item.title,
      item.lifecycle,
      item.classification,
      ...item.blockers.map((blocker) => blocker.label),
      ...item.nextActors,
      ...item.evidence.map((evidence) => evidence.excerpt),
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function groupTriageItems<Item extends ForkTriageItem>(items: ReadonlyArray<Item>) {
  return TRIAGE_GROUPS.map(([classification, label]) => ({
    classification,
    label,
    items: items
      .filter((item) => {
        const group =
          item.classification === "replaced" || item.classification === "stale-closed"
            ? item.classification
            : item.kind === "issue"
              ? "issue"
              : item.lifecycle === "closed" || item.lifecycle === "merged"
                ? item.lifecycle
                : item.classification;
        return group === classification;
      })
      .toSorted((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number),
  })).filter((group) => group.items.length > 0);
}

const markdownText = (value: string) =>
  value
    .replaceAll("—", ",")
    .replace(/[[\]\\]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();

type TriageMarkdownItem = ForkTriageItem & {
  readonly environmentLabel?: string;
  readonly environmentId?: string;
};

export function toTriageMarkdown<Item extends TriageMarkdownItem>(
  items: ReadonlyArray<Item>,
): string {
  const markers: Record<string, string> = {
    "ready-maintainer": ":pr-open:",
    review: ":review:",
    draft: ":pr-draft:",
  };
  return groupTriageItems(items)
    .map((group) =>
      [
        `${markers[group.classification] ?? ""} ${group.label}`.trim(),
        ...group.items.map((item) => {
          const blockers = item.blockers.map((blocker) => markdownText(blocker.label)).join("; ");
          const environment = item.environmentLabel ?? item.environmentId;
          return `- [${item.repo}#${item.number}](${item.url}) ${markdownText(item.title)}. ${environment ? `Environment: ${markdownText(environment)}. ` : ""}${item.nextActors.length ? `Next: ${item.nextActors.join(", ")}. ` : ""}${blockers ? `Blockers: ${blockers} ` : ""}[${item.certainty}]`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

export function triageScopes(report: ForkTriageReport | null): ReadonlyArray<string> {
  return report?.configSummary.scopes ?? [];
}

export function blockerSummary(item: ForkTriageItem): string {
  const checks = new Map<string, number>();
  const labels: string[] = [];
  for (const blocker of item.blockers) {
    if (
      /^(workflow-|check-)/.test(blocker.code) ||
      blocker.code === "maintainer-approval-required"
    ) {
      const state =
        blocker.code === "maintainer-approval-required"
          ? "awaiting authorization"
          : blocker.code.replace(/^(workflow-|check-)/, "").replaceAll("-", " ");
      checks.set(state, (checks.get(state) ?? 0) + 1);
    } else if (!labels.includes(blocker.label)) labels.push(blocker.label);
  }
  if (checks.size)
    labels.unshift(`CI: ${[...checks].map(([state, count]) => `${count} ${state}`).join(", ")}.`);
  return labels.length > 3
    ? `${labels.slice(0, 3).join(" ")} +${labels.length - 3} more in details.`
    : labels.join(" ") || "No recorded blockers.";
}
