import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/solid-router";
import Workspace from "./workspace/Workspace";
import Home from "./routes/Home";

// Root has no chrome — the Workspace owns its own tab bar. /debug keeps the
// Phase 0 spine check (HTTP/WS/hotkeys bridges) around for diagnostics.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Workspace,
});

const debugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug",
  component: Home,
});

const routeTree = rootRoute.addChildren([indexRoute, debugRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
