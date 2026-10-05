// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { TriageReport } from "@t3tools/contracts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const boundary = vi.hoisted(() => ({
  report: null as TriageReport | null,
  listeners: new Set<() => void>(),
  hydration: "ready",
  hydrate: vi.fn(async () => {}),
}));
vi.mock("./state", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useTriageEnvironmentId: () => "proof",
    useTriageReport: () => ({
      report: useSyncExternalStore(
        (listener) => {
          boundary.listeners.add(listener);
          return () => boundary.listeners.delete(listener);
        },
        () => boundary.report,
      ),
      loadError: null,
      updating: false,
      reload: () => {},
      refreshFromGitHub: async () => {},
    }),
  };
});
vi.mock("~/hooks/useSettings", () => ({
  useClientSettingsHydrationStatus: () => boundary.hydration,
  ensureClientSettingsHydrated: boundary.hydrate,
}));
vi.mock("./TriagePreferencesEditor", () => ({ TriagePreferencesEditor: () => null }));
vi.mock("./TriageDetailPane", () => ({ TriageDetailPane: () => <div>Selected PR details</div> }));
vi.mock("./TriageRow", () => ({ TriageRow: () => <li>Demo PR</li>, focusTriageRowSoon: () => {} }));
vi.mock("~/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("~/hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
import { TriagePage } from "./TriagePage";

it("keeps the selected PR URL during a preferences reload and closes only after confirmed removal", async () => {
  const pr = {
    key: { host: "github.com", repository: "acme/app", number: 100 },
    group: "drafts",
    status: "draft",
    updatedAt: "2026-10-04T00:00:00Z",
  } as TriageReport["pullRequests"][number];
  const report: TriageReport = {
    viewer: "synthetic",
    fetchedAt: "2026-10-04T00:00:00Z",
    error: null,
    pullRequests: [pr],
  };
  boundary.report = report;
  const rootRoute = createRootRoute({ component: Outlet });
  const chat = createRoute({ getParentRoute: () => rootRoute, id: "_chat", component: Outlet });
  const triage = createRoute({
    getParentRoute: () => chat,
    path: "/triage",
    component: TriagePage,
    validateSearch: (search) => search,
  });
  const history = createMemoryHistory({
    initialEntries: ["/triage?repository=acme%2Fapp&number=100"],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chat.addChildren([triage])]),
    history,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    expect(host.textContent).toContain("Selected PR details");
    const selectedUrl = history.location.href;
    await act(async () => {
      boundary.report = null;
      boundary.listeners.forEach((listener) => listener());
    });
    expect(history.location.href).toBe(selectedUrl);
    await act(async () => {
      boundary.report = { ...report };
      boundary.listeners.forEach((listener) => listener());
    });
    expect(host.textContent).toContain("Selected PR details");
    await act(async () => {
      boundary.report = { ...report, pullRequests: [] };
      boundary.listeners.forEach((listener) => listener());
    });
    expect(history.location.search).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("recovers the triage report after retrying a failed settings read", async () => {
  boundary.hydration = "failed";
  boundary.report = {
    viewer: "synthetic",
    fetchedAt: "2026-10-04T00:00:00Z",
    error: null,
    pullRequests: [],
  };
  boundary.hydrate
    .mockRejectedValueOnce(new Error("Synthetic storage unavailable"))
    .mockImplementationOnce(async () => {
      boundary.hydration = "ready";
    });
  const rootRoute = createRootRoute({ component: Outlet });
  const chat = createRoute({ getParentRoute: () => rootRoute, id: "_chat", component: Outlet });
  const triage = createRoute({
    getParentRoute: () => chat,
    path: "/triage",
    component: TriagePage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chat.addChildren([triage])]),
    history: createMemoryHistory({ initialEntries: ["/triage"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    expect(host.textContent).toContain("Synthetic storage unavailable");
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry preferences",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(host.textContent).toContain("No open pull requests of yours.");
    expect(host.textContent).not.toContain("Retry preferences");
  } finally {
    boundary.hydration = "ready";
    await act(async () => root.unmount());
    host.remove();
  }
});
