import { TriageContext, type TriageContext as AuthoredContext } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";

const decodeContext = Schema.decodeSync(TriageContext);

export function saveTriageContext(repository: string | null, draft: AuthoredContext | null) {
  const context = draft === null ? null : decodeContext(draft);
  return persistClientSettingsUpdate((current) => {
    const preferences = current.triagePreferences;
    if (repository === null) {
      return { ...current, triagePreferences: { ...preferences, global: context ?? {} } };
    }
    const repositories = { ...preferences.repositories };
    if (context === null) delete repositories[repository];
    else repositories[repository] = context;
    return { ...current, triagePreferences: { ...preferences, repositories } };
  });
}
