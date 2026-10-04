import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const persistence = vi.hoisted(() => ({ getClientSettings: vi.fn(), setClientSettings: vi.fn() }));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
import { __resetClientSettingsPersistenceForTests, getClientSettings } from "~/hooks/useSettings";
import { saveTriageContext } from "./preferences";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockResolvedValue({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });
  persistence.setClientSettings.mockResolvedValue(undefined);
});
it("hydrates before saving and keeps independent repository overrides and unrelated preferences", async () => {
  let durable: ClientSettings | null = null;
  persistence.setClientSettings.mockImplementation(async (settings: ClientSettings) => {
    durable = settings;
  });
  await Promise.all([
    saveTriageContext("github.com/acme/app", { aboutMe: "I own the demo app." }),
    saveTriageContext("github.com/acme/lib", { assessment: "Check compatibility." }),
  ]);
  expect(getClientSettings().wordWrap).toBe(false);
  expect(getClientSettings().triagePreferences.repositories).toEqual({
    "github.com/acme/app": { aboutMe: "I own the demo app." },
    "github.com/acme/lib": { assessment: "Check compatibility." },
  });
  await saveTriageContext("github.com/acme/app", null);
  expect(getClientSettings().triagePreferences.repositories).toEqual({
    "github.com/acme/lib": { assessment: "Check compatibility." },
  });
  expect(durable).toEqual(getClientSettings());
});
it("leaves the saved profile unchanged when persistence fails", async () => {
  const failure = new Error("storage unavailable");
  persistence.setClientSettings.mockRejectedValue(failure);
  await expect(saveTriageContext(null, { aboutMe: "Synthetic profile" })).rejects.toBe(failure);
  expect(getClientSettings().triagePreferences.global).toEqual({});
});
