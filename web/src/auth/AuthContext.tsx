import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { config } from "../config";

export interface User {
  id: string;
  email: string;
}

export interface AuthContextValue {
  user: User | null;
  /** The bearer token for API calls, or null when signed out. Stable: reads the current session. */
  getToken: () => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return config.authMode === "supabase" ? <SupabaseAuthProvider>{children}</SupabaseAuthProvider> : <MockAuthProvider>{children}</MockAuthProvider>;
}

// --- Mock auth: any email and password sign in as a fake user ---------------------------

const MOCK_USER_KEY = "autoace.mockUser";
export const MOCK_TOKEN_PREFIX = "mock-token:";

function loadMockUser(): User | null {
  try {
    const raw = sessionStorage.getItem(MOCK_USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function MockAuthProvider({ children, initialUser }: { children: ReactNode; initialUser?: User | null }) {
  const [user, setUser] = useState<User | null>(() => (initialUser !== undefined ? initialUser : loadMockUser()));
  const userRef = useRef(user); // read by getToken, so getToken never changes identity

  const signIn = useCallback(async (email: string, password: string) => {
    const trimmed = email.trim();
    if (!trimmed || !password) throw new Error("Enter your email and password.");
    const next = { id: `mock-${trimmed.toLowerCase()}`, email: trimmed };
    try {
      sessionStorage.setItem(MOCK_USER_KEY, JSON.stringify(next));
    } catch {
      // private mode or storage blocked: stay signed in for this page only
    }
    userRef.current = next;
    setUser(next);
  }, []);

  const signOut = useCallback(async () => {
    try {
      sessionStorage.removeItem(MOCK_USER_KEY);
    } catch {
      // nothing stored
    }
    userRef.current = null;
    setUser(null);
  }, []);

  const getToken = useCallback(async () => (userRef.current ? `${MOCK_TOKEN_PREFIX}${userRef.current.id}` : null), []);

  const value = useMemo(() => ({ user, getToken, signIn, signOut }), [user, getToken, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// --- Supabase auth ----------------------------------------------------------------------

/**
 * TODO(supabase): implement with @supabase/supabase-js (installed, not imported yet):
 *
 *   import { createClient } from "@supabase/supabase-js";
 *   const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
 *
 * - signIn: supabase.auth.signInWithPassword({ email, password }); show error.message on failure.
 *   No sign-up: accounts are created by us in the Supabase dashboard.
 * - On mount: supabase.auth.getSession() for the initial user, and
 *   supabase.auth.onAuthStateChange(...) to follow sign-in, sign-out and TOKEN_REFRESHED
 *   (supabase-js refreshes the session itself; unsubscribe on unmount).
 * - getToken: (await supabase.auth.getSession()).data.session?.access_token ?? null, read
 *   fresh on every call so a refreshed token is used.
 * - signOut: supabase.auth.signOut().
 * - user: { id: session.user.id, email: session.user.email }. The API must read the user ID
 *   from the verified JWT (claims.sub), never from anything the browser sends.
 */
const NOT_CONNECTED: AuthContextValue = {
  user: null,
  getToken: async () => null,
  signIn: async () => {
    throw new Error("Supabase sign-in is not connected yet. Set VITE_AUTH_MODE=mock for now.");
  },
  signOut: async () => {},
};

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  return <AuthContext.Provider value={NOT_CONNECTED}>{children}</AuthContext.Provider>;
}
