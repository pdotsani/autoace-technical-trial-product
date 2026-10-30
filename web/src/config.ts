// Build-time settings from VITE_* env vars (public values only; see .env.example).

export type ApiMode = "mock" | "live";
export type AuthMode = "mock" | "supabase";

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export const config = {
  apiMode: pick<ApiMode>(import.meta.env.VITE_API_MODE, ["mock", "live"], "mock"),
  apiUrl: (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, ""),
  authMode: pick<AuthMode>(import.meta.env.VITE_AUTH_MODE, ["mock", "supabase"], "mock"),
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? "",
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
};
