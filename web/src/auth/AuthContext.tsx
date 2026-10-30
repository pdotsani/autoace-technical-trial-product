import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Loading } from "../components/States";
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
// Accounts are created in the Supabase dashboard: there is no sign-up here. The API reads the
// user ID from the verified access token (its sub), never from anything else the browser sends.

function toUser(session: Session | null): User | null {
  return session ? { id: session.user.id, email: session.user.email ?? "" } : null;
}

// One client for the page: StrictMode runs useState initializers twice in development, and two
// clients would share (and fight over) the same stored session.
let supabaseClient: SupabaseClient | null | undefined;
function getSupabase(): SupabaseClient | null {
  supabaseClient ??= config.supabaseUrl && config.supabaseAnonKey ? createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  return supabaseClient;
}

const NOT_CONFIGURED: AuthContextValue = {
  user: null,
  getToken: async () => null,
  signIn: async () => {
    throw new Error("Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  },
  signOut: async () => {},
};

function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabase();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    // Keep the same object while the user is unchanged, so a token refresh doesn't re-render the app
    const follow = (session: Session | null) => setUser((prev) => (prev?.id === session?.user.id ? prev : toUser(session)));
    void supabase.auth.getSession().then(({ data }) => {
      follow(data.session);
      setReady(true);
    });
    // Sign-in, sign-out and TOKEN_REFRESHED (supabase-js refreshes the session itself)
    const { data } = supabase.auth.onAuthStateChange((_event, session) => follow(session));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!email.trim() || !password) throw new Error("Enter your email and password.");
      const { data, error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(error.message);
      setUser(toUser(data.session)); // before navigating away from the login page
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    await supabase!.auth.signOut();
  }, [supabase]);

  // Read fresh on every call, so a refreshed token is used
  const getToken = useCallback(async () => (await supabase!.auth.getSession()).data.session?.access_token ?? null, [supabase]);

  const value = useMemo(() => ({ user, getToken, signIn, signOut }), [user, getToken, signIn, signOut]);
  if (!supabase) return <AuthContext.Provider value={NOT_CONFIGURED}>{children}</AuthContext.Provider>;
  if (!ready) return <Loading label="Checking sign-in…" />; // don't send a signed-in user to the login page
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
