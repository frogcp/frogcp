import type { AuthUser } from "frogcp/client";
import { type FormEvent, useState } from "react";
import { client } from "../api";
import { Button, Card, FrogMark, Input, Label } from "@/components/ui";

export interface LoginScreenProps {
  onLogin: (user: AuthUser) => void;
}

/**
 * The unauthenticated shell's entire surface: an email/password form that
 * calls `client.auth.login` and hands the returned `AuthUser` up to `App`.
 * Nothing is written to storage here; the session cookie `frogcp/auth` sets is
 * what actually persists the login.
 */
export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { user } = await client.auth.login({ email, password });
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-10">
      <div className="w-[400px] max-w-full">
        <div className="mb-7 flex items-center justify-center gap-2.5">
          <FrogMark size={30} />
          <span className="font-sans text-xl font-bold tracking-tight text-foreground">frogCP Admin</span>
        </div>
        <Card className="gap-0 p-7.5 shadow-[var(--shadow-elevated)]">
          <h1 className="mb-1.5 text-[22px] font-bold tracking-tight text-foreground">Sign in</h1>
          <p className="mb-5.5 text-sm text-muted-foreground">
            Manage your backend&apos;s data, users, and permissions.
          </p>
          <form onSubmit={handleSubmit}>
            <div className="mb-4 flex flex-col gap-3.5">
              <div className="grid gap-1.5">
                <Label htmlFor="admin-login-email" className="text-[12.5px] font-normal text-muted-foreground">
                  Email
                </Label>
                <Input
                  id="admin-login-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="admin-login-password" className="text-[12.5px] font-normal text-muted-foreground">
                  Password
                </Label>
                <Input
                  id="admin-login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </div>
            {error && (
              <p role="alert" className="mb-3 text-[13px] text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting} className="w-full justify-center">
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
