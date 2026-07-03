import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/solid-router";
import Home from "./routes/Home";
import TerminalRoute from "./routes/TerminalRoute";

const rootRoute = createRootRoute({
  component: () => (
    <div class="app-shell">
      <nav class="nav">
        <span class="brand">t-bias</span>
        <Link to="/" class="nav-link" activeProps={{ class: "nav-link active" }}>
          Home
        </Link>
        <Link
          to="/terminal"
          class="nav-link"
          activeProps={{ class: "nav-link active" }}
        >
          Terminal
        </Link>
      </nav>
      <main class="content">
        <Outlet />
      </main>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terminal",
  component: TerminalRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, terminalRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}
