import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AppRoutes, Providers } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { createMockApi, type MockOptions } from "../src/api/mock";
import { MockAuthProvider } from "../src/auth/AuthContext";

export const USER = { id: "user-1", email: "pat@example.com" };

/** A mock API with no simulated delays and a controllable clock. */
export function testApi(options: MockOptions = {}) {
  let time = Date.parse("2026-10-29T12:00:00Z");
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const api = createMockApi(async () => USER.id, { now: clock.now, latencyMs: 0, uploadMs: 0, random: () => 0.5, ...options });
  return { api, clock };
}

export function renderApp(api: ApiClient, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Providers client={api} auth={(children) => <MockAuthProvider initialUser={USER}>{children}</MockAuthProvider>}>
        <AppRoutes />
      </Providers>
    </MemoryRouter>,
  );
}

export function file(name: string, content: string | Uint8Array = "x".repeat(100), type = ""): File {
  return new File([content as BlobPart], name, { type });
}

export const CSV_TEXT = "name,result_json\ncall_001.ogg,\ncall_002.ogg,\ncall_003.ogg,\n";
