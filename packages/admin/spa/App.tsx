import type { AuthUser } from "frogcp/client";
import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { client } from "./api";
import { LoginScreen } from "./screens/LoginScreen";
import { ShellScreen } from "./screens/ShellScreen";

/**
 * The whole SPA's top-level state machine: "checking" (boot-time
 * `client.auth.me()` in flight) -> "anonymous" (show `LoginScreen`) ->
 * "authenticated" (show `ShellScreen`). Nothing is persisted client-side; the
 * session cookie IS the persistence, so a reload always re-runs
 * `client.auth.me()` to re-derive this state.
 */
export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client
      .auth.me()
      .then(({ user: me }) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="boot-screen" role="status">
        Loading…
      </div>
    );
  }

  return (
    <BrowserRouter basename="/admin">
      {/* The toast surface has to be mounted once at the root. Nothing calls
          `toast()` yet, so it renders nothing until a screen opts in. */}
      <Toaster />
      <Routes>
        <Route
          path="*"
          element={
            user ? (
              <ShellScreen user={user} onLogout={() => setUser(null)} />
            ) : (
              <LoginScreen onLogin={setUser} />
            )
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
