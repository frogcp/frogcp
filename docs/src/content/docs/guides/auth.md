---
title: Auth
description: "The frogcp/auth plugin: email and password routes, sessions and cookies, OAuth providers, password reset, the users entity, and jwtVerifyPlugin."
sidebar:
  order: 1
---

`frogcp/auth` is the first-party identity plugin. It contributes a `users`
entity, resolves the caller's identity from a signed session token, and
registers the email/password routes. It is a plugin like any other, so a
backend has auth only when you wire it in.

```ts
import { createBackend } from "frogcp";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { authPlugin } from "frogcp/auth";
import config from "./frogcp.config";

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  plugins: [authPlugin({ secret: process.env.AUTH_SECRET! })],
});
```

The plugin currently requires a SQLite-dialect adapter. It reads and writes
`users` through `adapter.db` directly rather than the data engine, and its
`onBoot` throws at `createBackend` time on any other dialect.

## Options

`authPlugin(opts)` takes:

| Option | Default | Meaning |
| --- | --- | --- |
| `secret` | required | HS256 signing secret for session JWTs. Must be at least 32 characters; the factory throws otherwise. |
| `emailPassword` | `true` | Register the email/password routes. |
| `oauth` | none | `{ github?, google?, oidc? }`, see [OAuth providers](#oauth-providers). |
| `baseUrl` | none | Absolute base URL the backend is served from. Required when `oauth` is set, since redirect URIs are built from it. |
| `sessionTtlSeconds` | `604800` | Session lifetime, seven days. |
| `cookieName` | `"frogcp_session"` | Name of the session cookie. |
| `secureCookies` | `false` | Append `; Secure` to every cookie the plugin issues. Set it in production. |
| `resetMailer` | none | Delivers self-serve password-reset tokens, see [Password reset](#password-reset). |
| `oauthFetch` | `globalThis.fetch` | Overrides the `fetch` used for OAuth discovery, token exchange, and userinfo. Exists for tests. |

Both guards run synchronously at construction, so a short secret or an OAuth
config with no `baseUrl` fails before the process serves anything.

## Email and password routes

With `emailPassword` on, the plugin registers these on the kernel's Hono app:

| Route | Purpose |
| --- | --- |
| `POST /api/auth/register` | Create an account. Body `{ email, password, name? }`. Answers `201` with `{ data: { user } }` and sets the session cookie. |
| `POST /api/auth/login` | Body `{ email, password }`. Answers `200` with `{ data: { user } }` and sets the session cookie. |
| `POST /api/auth/logout` | Clears the session cookie. Always `200`, even with no session. |
| `GET /api/auth/me` | The authenticated caller's user row, or `401`. |
| `POST /api/auth/password` | Change your own password. Body `{ currentPassword, newPassword }`. |
| `POST /api/auth/password-reset/request` | Self-serve reset. Body `{ email }`. Always `202`. |
| `POST /api/auth/password-reset/issue` | Admin-issued reset token. Body `{ email }`. |
| `POST /api/auth/password-reset/confirm` | Body `{ token, newPassword }`. |

Register reads only `email`, `password`, and `name` from the body, so a
`role` or `passwordHash` key stuffed into the payload is ignored. Passwords
must be 8 to 256 characters. Emails are trimmed and lowercased before storage
and lookup, so `Alice@Example.com` and `alice@example.com` are one account, and
`email` is `.unique()`, so a duplicate registration is a `409`.

Login answers a single `401 invalid credentials` for both an unknown email and
a wrong password, and runs the password hash against a fixed dummy hash on the
unknown-email path so the timing matches. Passwords are hashed with scrypt
through `@noble/hashes`, using WebCrypto only, so the same code runs on Node
and on Workers.

Every route returns the user through the same public shape:
`{ id, email, name, role, createdAt }`.

## Sessions and cookies

A session is an HS256 JWT with `sub` set to the user id, `iss` set to
`frogcp/auth`, and `exp` set to `iat + sessionTtlSeconds`. `verifySession`
requires that exact issuer, so a token signed with the same secret for another
purpose is not accepted as a session.

The cookie is `HttpOnly`, `Path=/`, `SameSite=Lax`, with `Max-Age` matching the
TTL, plus `Secure` when `secureCookies` is set. Logout sends the same attribute
set with an empty value and `Max-Age=0`.

On each request the plugin's `identify` hook takes the token from
`Authorization: Bearer <token>` if present, otherwise from the named cookie,
verifies it, and then looks up the user's current `role` in the database. The
role comes from the row, never from the token, so a role change or a deletion
takes effect on the next request instead of waiting out the session TTL. No
token, a failed verification, or a deleted user all resolve to guest (`null`).

The session helpers are exported if you need them directly:

```ts
import {
  clearSessionCookie,
  extractToken,
  issueSession,
  verifySession,
} from "frogcp/auth";
```

`hashPassword` and `verifyPassword` are exported too.

## The users entity

`authPlugin` contributes two entities, `users` and `oauthAccounts`, merged into
your config at boot. You do not declare them yourself, and a `ref("users")` in
your own config resolves against the plugin's entity.

```ts
const users = entity({
  email: text().required().unique(),
  passwordHash: text().hidden(),
  name: text(),
  role: text().required().default("member").readonly(),
  resetTokenHash: text().hidden(),
  resetTokenExpiresAt: timestamp().hidden(),
  createdAt: timestamp().auto(),
}).permissions({
  read: rule.owner("id"),
  update: rule.owner("id"),
});
```

The permissions are self-service. A member reads and updates their own row and
nothing else. `create`, `list`, and `delete` declare no rule, so they
default-deny for everyone except admin, which the permission engine always
allows. `role` is `.readonly()`, which keeps it visible but writable only by an
admin, so a member cannot PATCH their own row to `"admin"` under the
self-service update rule. `passwordHash` and both reset-token fields are
`.hidden()`, so they never appear in a response.

`oauthAccounts` links a provider identity (`provider`, `subject`) to a `users`
row. It declares no permissions at all, so it is admin-only bookkeeping.

## Roles and the first user

A role is just a string on the user row. `"admin"` is the one the permission
engine treats specially: an admin caller bypasses every rule.

New accounts get `"member"`, with one exception. The first user this backend
has ever seen becomes `"admin"`. The rule is applied by a single helper both
creation paths share, register and OAuth alike, so it holds however the first
account arrives. Without it a fresh backend could never reach an admin-only
action.

The check counts existing rows and then inserts, with no transaction around the
pair, so two genuinely concurrent first-ever registrations could both become
admin. That race is accepted for now.

## OAuth providers

Set `oauth` and `baseUrl` to add the authorization-code flow. GitHub and Google
are presets; anything else is a generic OIDC entry resolved through discovery
at `${issuer}/.well-known/openid-configuration`.

```ts
authPlugin({
  secret: process.env.AUTH_SECRET!,
  baseUrl: "https://app.example.com",
  oauth: {
    github: { clientId: "...", clientSecret: "..." },
    google: { clientId: "...", clientSecret: "..." },
    oidc: [
      {
        name: "acme",
        issuer: "https://id.acme.com",
        clientId: "...",
        clientSecret: "...",
      },
    ],
  },
});
```

Each configured provider gets two routes, where `:provider` is `github`,
`google`, or an `oidc` entry's `name`:

- `GET /api/auth/oauth/:provider` sets a short-lived state cookie and redirects
  to the provider's authorize URL.
- `GET /api/auth/oauth/:provider/callback` checks the state, exchanges the code
  server-side, fetches the user info, links or creates the `users` row, sets the
  session cookie, and redirects to `/`.

The redirect URI is `${baseUrl}/api/auth/oauth/${provider}/callback`, which is
what you register with the provider. Two providers claiming the same name throw
at route-registration time. The state cookie is checked before the code, so a
callback that did not originate from this backend's redirect is a `403`
regardless of what it carries.

A provider email that the issuer asserts as `email_verified: false` can neither
link to nor create an account. An absent claim is treated as verified, since
many issuers omit it. The GitHub preset reads only verified addresses.

## Password reset

There are two ways to get a token into a user's hands, and one route that
consumes it.

`POST /api/auth/password-reset/request` is the self-serve path. It answers
`202` with the same body for every input, whether the email exists, is
malformed, or no mailer is configured, so it is not an account-enumeration
oracle. A token is minted and delivered only when both a matching user and a
`resetMailer` exist. A mailer that throws is logged and swallowed.

```ts
import { authPlugin } from "frogcp/auth";
import { consoleTransport, mailPlugin, passwordResetEmail } from "frogcp/mail";

const mail = mailPlugin({
  from: "Acme <noreply@acme.com>",
  transport: consoleTransport(),
});

const auth = authPlugin({
  secret: process.env.AUTH_SECRET!,
  resetMailer: passwordResetEmail(mail, { origin: "https://app.example.com" }),
});

// createBackend({ ..., plugins: [mail, auth] })
```

`resetMailer` is a `(info) => Promise<void>` receiving
`{ email, resetToken, expiresAt }`. `passwordResetEmail` from
[`frogcp/mail`](/guides/mail/) is a ready-made one; anything with that shape
works.

`POST /api/auth/password-reset/issue` is the admin path, and needs no mail
infrastructure. It is admin-only and answers `{ data: { resetToken, expiresAt } }`.
That is the only time the plaintext token exists; only its SHA-256 hash is
stored.

`POST /api/auth/password-reset/confirm` takes `{ token, newPassword }`. Tokens
live one hour and are single-use, enforced by a conditional update, so two
racing confirms leave exactly one winner. Unknown, expired, and already-used
tokens are all the same `404`. A successful confirm does not issue a session;
the caller logs in with the new password. Setting a password by either route
also clears any outstanding reset token.

## Verifying tokens from another issuer

`jwtVerifyPlugin` is the alternative when identity lives somewhere else
entirely, such as Auth0, Clerk, or your own gateway. It contributes no
entities, no cookies, and no routes. It only implements `identify`, reading a
bearer token and turning its claims into the same `Ctx` the permission engine
consumes.

```ts
import { jwtVerifyPlugin } from "frogcp/auth";

const plugin = jwtVerifyPlugin({
  jwksUrl: "https://id.example.com/.well-known/jwks.json",
  issuer: "https://id.example.com/",
  audience: "my-api",
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `secret` | none | HS256 shared secret, at least 32 characters. |
| `jwksUrl` | none | Remote JWKS URL for RS, PS, ES, or EdDSA issuers. |
| `issuer` | none | When set, the token's `iss` must match exactly. |
| `audience` | none | When set, the token's `aud` must match exactly. |
| `userIdClaim` | `"sub"` | Claim the user id is read from. |
| `roleClaim` | `"role"` | Claim the role is read from. |

Exactly one of `secret` and `jwksUrl` is required; the factory throws
otherwise. A secret instance is pinned to HS256, and a JWKS instance accepts
only asymmetric algorithms, which closes the algorithm-confusion attack where a
token forged as HS256 is signed with the public key bytes.

A missing or empty user id claim resolves the caller to guest. A missing or
empty role claim falls back to `"member"`, never `"admin"`, so an omitted claim
cannot grant elevated access. Any verification failure resolves to guest rather
than throwing. The full payload is carried through on `ctx.claims`.
