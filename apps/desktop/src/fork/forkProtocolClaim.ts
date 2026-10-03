import * as Electron from "electron";

import type { DesktopIdentity } from "./forkDesktopIdentity.ts";

interface ProtocolClient {
  setAsDefaultProtocolClient: (protocol: string) => boolean;
}

/**
 * Runs `create` without letting it make this app the system default for a URL
 * scheme when the fork runs. The Clerk bridge claims `t3code://` on startup,
 * which would route the official app's sign-in links to the fork.
 */
export function withoutDefaultProtocolClaim<T>(
  app: ProtocolClient,
  identity: DesktopIdentity,
  create: () => T,
): T {
  if (identity !== "fork") {
    return create();
  }
  const claim = app.setAsDefaultProtocolClient;
  app.setAsDefaultProtocolClient = () => false;
  try {
    return create();
  } finally {
    app.setAsDefaultProtocolClient = claim;
  }
}

export function withoutForkProtocolClaim<T>(identity: DesktopIdentity, create: () => T): T {
  return withoutDefaultProtocolClaim(Electron.app, identity, create);
}
