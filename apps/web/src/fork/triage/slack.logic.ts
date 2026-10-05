import type { TriagePreferences, TriagePullRequest } from "@t3tools/contracts";
import { effectiveTriageActions, compareTriagePullRequests } from "./grouping.logic";

export function triageSummary(pr: TriagePullRequest) {
  const state = pr.judgement;
  const summary =
    state?._tag === "ready" && state.judgement.headSha === pr.headSha
      ? state.judgement.summary
      : pr.title;
  return summary.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function serializeTriageSlack(
  prs: ReadonlyArray<TriagePullRequest>,
  preferences: TriagePreferences,
) {
  const entries = prs.toSorted(compareTriagePullRequests).flatMap((pr) => {
    const actions = effectiveTriageActions(pr, preferences).filter(
      (action) => action.owner === "team",
    );
    if (actions.length === 0) return [];
    const asks = actions
      .map(({ label }) => label.replace(/\s+/g, " ").trim())
      .map((label) => label.charAt(0).toLowerCase() + label.slice(1));
    const ask = `Please ${asks.join(" and ")}.`;
    const summary = triageSummary(pr).replace(/[.!?]$/, "");
    const url = new URL(pr.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return [];
    return [
      {
        text: `[#${pr.key.number}](${pr.url}) ${summary}. ${ask}`,
        html: `<p><a href="${escapeHtml(pr.url)}">#${pr.key.number}</a> ${escapeHtml(summary)}. ${escapeHtml(ask)}</p>`,
      },
    ];
  });
  return {
    text: entries.map(({ text }) => text).join("\n"),
    html: entries.map(({ html }) => html).join(""),
  };
}
