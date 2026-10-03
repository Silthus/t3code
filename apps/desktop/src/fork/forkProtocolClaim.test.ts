import { describe, expect, it } from "vite-plus/test";

import { withoutDefaultProtocolClaim } from "./forkProtocolClaim.ts";

function launchServices() {
  const claimed: string[] = [];
  const app = {
    setAsDefaultProtocolClient: (protocol: string) => {
      claimed.push(protocol);
      return true;
    },
  };
  return { app, claimed };
}

const bridgeThatClaims = (app: { setAsDefaultProtocolClient: (protocol: string) => boolean }) =>
  app.setAsDefaultProtocolClient("t3code") ? "bridge" : "bridge without claim";

describe("default protocol claim", () => {
  it("keeps t3code:// with the official app while the fork starts its bridge", () => {
    const { app, claimed } = launchServices();

    const bridge = withoutDefaultProtocolClaim(app, "fork", () => bridgeThatClaims(app));

    expect(bridge).toBe("bridge without claim");
    expect(claimed).toEqual([]);
  });

  it("lets the fork claim protocols again once its bridge exists", () => {
    const { app, claimed } = launchServices();

    withoutDefaultProtocolClaim(app, "fork", () => bridgeThatClaims(app));
    app.setAsDefaultProtocolClient("other");

    expect(claimed).toEqual(["other"]);
  });

  it("lets the official app claim t3code://", () => {
    const { app, claimed } = launchServices();

    withoutDefaultProtocolClaim(app, "upstream", () => bridgeThatClaims(app));

    expect(claimed).toEqual(["t3code"]);
  });
});
