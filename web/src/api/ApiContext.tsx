import { createContext, useContext, useState, type ReactNode } from "react";

import { MOCK_TOKEN_PREFIX, useAuth } from "../auth/AuthContext";
import { config } from "../config";
import type { ApiClient } from "./client";
import { createLiveApi } from "./live";
import { createMockApi } from "./mock";

const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi must be used inside <ApiProvider>");
  return client;
}

/** Picks the API implementation from VITE_API_MODE; tests pass `client` directly. */
export function ApiProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const { getToken } = useAuth(); // stable, so capturing it once is safe
  // Created once: the mock keeps its runs in memory for the life of the page
  const [value] = useState<ApiClient>(() => {
    if (client) return client;
    if (config.apiMode === "live") return createLiveApi(config.apiUrl, getToken);
    return createMockApi(async () => {
      const token = await getToken();
      return token?.startsWith(MOCK_TOKEN_PREFIX) ? token.slice(MOCK_TOKEN_PREFIX.length) : token;
    });
  });
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}
