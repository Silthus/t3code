import { describe, expect, it } from "vite-plus/test";

import { FORK_APP_BUNDLE_ID, FORK_APP_NAME, resolveForkPaths } from "./ForkDesktopIdentity.ts";

describe("ForkDesktopIdentity", () => {
  it("uses a stable identity and disjoint runtime paths", () => {
    const paths = resolveForkPaths({
      homeDirectory: "/Users/alice",
      joinPath: (first, ...segments) => [first, ...segments].join("/"),
    });

    expect(FORK_APP_NAME).toBe("T3 Code Fork");
    expect(FORK_APP_BUNDLE_ID).toBe("com.t3tools.t3code.fork");
    expect(paths.t3Home).toBe("/Users/alice/Library/Application Support/T3 Code Fork/t3-home");
    expect(paths.userDataDirectory).toBe(
      "/Users/alice/Library/Application Support/T3 Code Fork/user-data",
    );
    expect(paths.secretsFile).toBe(
      "/Users/alice/Library/Application Support/T3 Code Fork/secrets.env",
    );
    expect(paths.t3Home).not.toBe(paths.userDataDirectory);
  });
});
