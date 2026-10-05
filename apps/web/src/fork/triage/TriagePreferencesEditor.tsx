import {
  TRIAGE_PRESETS,
  TRIAGE_PROFILE_SECTIONS,
  triageRepositoryId,
  type TriageContext,
  type TriagePullRequest,
} from "@t3tools/contracts";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { saveTriageContext } from "./preferences";

export function TriagePreferencesEditor({
  pullRequests,
}: {
  pullRequests: ReadonlyArray<TriagePullRequest>;
}) {
  const { triagePreferences: saved } = useClientSettings();
  const hydrated = useClientSettingsHydrated();
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState<string | null>(null);
  const [draft, setDraft] = useState<TriageContext>({});
  const [tab, setTab] = useState<"profile" | "assessment" | "actions">("profile");
  const [reset, setReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const repositories = [
    ...new Set([
      ...pullRequests.map((pr) => triageRepositoryId(pr.key)),
      ...Object.keys(saved.repositories),
    ]),
  ].sort();
  const edit = (scope: string | null) => {
    setRepository(scope);
    setDraft(scope === null ? saved.global : (saved.repositories[scope] ?? {}));
    setReset(false);
    setError(null);
  };
  const fields =
    tab === "profile"
      ? TRIAGE_PROFILE_SECTIONS
      : ([["assessment", "Assessment instructions"]] as const);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!hydrated}
        onClick={() => {
          edit(null);
          setOpen(true);
        }}
      >
        Triage preferences
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <DialogPopup showCloseButton={!saving}>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={async (event) => {
              event.preventDefault();
              if (saving) return;
              setSaving(true);
              setError(null);
              try {
                await saveTriageContext(repository, reset ? null : draft);
                setOpen(false);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not save preferences. Try again.",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Triage preferences</DialogTitle>
              <DialogDescription>
                Saved only in this browser or desktop installation, not synced across devices. Your
                resolved profile is sent to the serving environment and its assessment provider when
                needed. New thread drafts include your profile and action instructions.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label id={`${id}-scope`}>Scope</Label>
                  <Select
                    value={repository ?? "global"}
                    disabled={saving}
                    onValueChange={(value) => edit(value === "global" ? null : value)}
                  >
                    <SelectTrigger aria-labelledby={`${id}-scope`}>
                      <SelectValue>{repository ?? "Global defaults"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="global">Global defaults</SelectItem>
                      {repositories.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {repository === null
                      ? "Empty fields use the built-in behavior."
                      : "Nonempty repository fields replace global fields. Empty fields inherit global defaults."}{" "}
                    Changes apply after Save. Existing drafts keep their text.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2" aria-label="Instruction sections">
                  {(["profile", "assessment", "actions"] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={tab === value ? "secondary" : "ghost"}
                      aria-pressed={tab === value}
                      onClick={() => setTab(value)}
                    >
                      {value === "profile"
                        ? "Profile"
                        : value === "assessment"
                          ? "Assessment"
                          : "Actions"}
                    </Button>
                  ))}
                </div>
                {tab === "actions" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Additional instructions for each preset. The original task and PR link are
                      kept. These open unsent drafts.
                    </p>
                    {TRIAGE_PRESETS.map(([preset, label]) => (
                      <div key={preset} className="flex flex-col gap-2">
                        <Label htmlFor={`${id}-${preset}`}>{label}</Label>
                        <Textarea
                          id={`${id}-${preset}`}
                          rows={3}
                          maxLength={8000}
                          disabled={saving}
                          value={draft.actions?.[preset] ?? ""}
                          placeholder={
                            repository
                              ? saved.global.actions?.[preset] || "Use built-in behavior"
                              : "Use built-in behavior"
                          }
                          onChange={(event) => {
                            setReset(false);
                            setDraft({
                              ...draft,
                              actions: { ...draft.actions, [preset]: event.target.value },
                            });
                          }}
                        />
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {tab === "assessment" ? (
                      <p className="text-xs text-muted-foreground">
                        Additional priorities for risk assessment. Required summary, risk and risk
                        reason stay enforced. Saving a changed profile invalidates earlier
                        assessments; drafts remain manual.
                      </p>
                    ) : null}
                    {fields.map(([field, label]) => (
                      <div key={field} className="flex flex-col gap-2">
                        <Label htmlFor={`${id}-${field}`}>{label}</Label>
                        <Textarea
                          id={`${id}-${field}`}
                          rows={3}
                          maxLength={8000}
                          disabled={saving}
                          value={draft[field] ?? ""}
                          placeholder={
                            repository
                              ? saved.global[field] || "Inherit global defaults"
                              : "Optional"
                          }
                          onChange={(event) => {
                            setReset(false);
                            setDraft({ ...draft, [field]: event.target.value });
                          }}
                        />
                      </div>
                    ))}
                  </>
                )}
                {reset ? (
                  <p role="status" className="text-sm">
                    {repository
                      ? "Override will be removed when you save."
                      : "Defaults will be restored when you save."}
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft({});
                  setReset(true);
                }}
              >
                {repository ? "Remove override" : "Reset to defaults"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
