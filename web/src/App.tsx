import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";

import { ApiProvider } from "./api/ApiContext";
import { ApiError, type ApiClient } from "./api/client";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Header } from "./components/Header";
import { LoginPage } from "./pages/LoginPage";
import { NewBatchPage } from "./pages/NewBatchPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 4xx answers won't change on retry; network errors and 5xx get two more tries
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Providers without the router, so tests can wrap pages in a MemoryRouter. */
export function Providers({ children, client, auth }: { children: ReactNode; client?: ApiClient; auth?: (children: ReactNode) => ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const inner = (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={client}>{children}</ApiProvider>
    </QueryClientProvider>
  );
  return <>{auth ? auth(inner) : <AuthProvider>{inner}</AuthProvider>}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Navigate to="/runs" replace />} />
        <Route path="/new" element={<NewBatchPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <Providers>
      <AppRoutes />
    </Providers>
  );
}

/** Signed-in layout; anyone signed out goes to /login and comes back afterwards. */
function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" className="page" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
