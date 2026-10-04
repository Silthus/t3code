import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema } from "./settings.ts";
import { resolveTriageContext } from "./forkTriageContext.ts";

const decodeSettings = Schema.decodeSync(ClientSettingsSchema);

it("resolves authored repository sections over global sections and restores global on removal", () => {
  const preferences = {
    global: {
      aboutMe: "I maintain synthetic widgets.",
      assessment: "Check retries.",
      actions: { "fix-ci": "Use focused tests." },
    },
    repositories: {
      "github.com/acme/app": {
        aboutMe: "I own the demo app.",
        assessment: "  ",
        actions: { "fix-ci": "Check the demo suite." },
      },
    },
  };
  const key = { host: "GitHub.com", repository: "Acme/App" };
  expect(resolveTriageContext(preferences, key)).toMatchObject({
    aboutMe: "I own the demo app.",
    assessment: "Check retries.",
    actions: { "fix-ci": "Check the demo suite." },
  });
  expect(resolveTriageContext({ ...preferences, repositories: {} }, key)).toMatchObject({
    aboutMe: "I maintain synthetic widgets.",
    actions: { "fix-ci": "Use focused tests." },
  });
  expect(decodeSettings({}).triagePreferences).toEqual({
    global: {},
    repositories: {},
  });
});
