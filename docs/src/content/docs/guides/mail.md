---
title: Mail
description: The frogcp/mail plugin, the one-function MailTransport contract, the shipped transports, and the passwordResetEmail adapter.
sidebar:
  order: 4
---

`frogcp/mail` is transactional email as a plugin. The kernel knows nothing
about email, so the plugin carries its own service handle: construct it once,
put it in `plugins`, and hand its `mailer` to whatever needs to send.

```ts
import { createBackend } from "frogcp";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { consoleTransport, mailPlugin } from "frogcp/mail";
import config from "./frogcp.config";

const mail = mailPlugin({
  from: "Acme <noreply@acme.com>",
  transport: consoleTransport(),
});

const backend = await createBackend({
  config,
  adapter: nodeSqliteAdapter("data.sqlite"),
  plugins: [mail],
});

await mail.mailer.send({ to: "user@example.com", subject: "Hi", text: "Hello." });
```

`mailPlugin` takes a default `from` (it throws on an empty one) and a
transport. It contributes no entities and no routes. It logs the active
configuration once at boot, so a deployment's logs say whether mail is real or
console only.

The returned `MailPlugin` is a `FrogPlugin` with a `mailer` attached:

```ts
interface Mailer {
  send(message: Omit<MailMessage, "from"> & { from?: string }): Promise<void>;
}
```

`send` fills `from` from the plugin's default whenever a call does not carry
its own.

## The transport contract

A transport is how a message leaves the process. It is one function:

```ts
interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

type MailTransport = (message: MailMessage) => Promise<void>;
```

Messages are plain text, with a single recipient, and `from` accepts either
`Name <addr@host>` or a bare address.

A transport should throw on failure. The caller decides whether delivery is
best effort or fatal, so a transport's only job is to deliver or raise.

## The transports that ship

### consoleTransport

```ts
consoleTransport(log?: (line: string) => void)
```

Writes the whole message to the console, or to the function you pass, instead
of sending it. This is the development default: password-reset links land in
your terminal with no provider account.

### resendTransport

```ts
resendTransport({ apiKey, fetchImpl? })
```

Posts to Resend's REST API. The sending domain has to be verified there. It is
plain `fetch`, so it behaves the same on Node and on Workers. `fetchImpl` is a
test seam defaulting to `globalThis.fetch`.

### sendEmailBindingTransport

```ts
sendEmailBindingTransport(env.EMAIL)
```

Cloudflare Email Service through its `send_email` Worker binding. No MIME
building: the binding takes `{ from, to, subject, text }` directly. It needs an
onboarded sending domain, and `from` must be on that domain. The binding throws
on failure, which is already this contract, so nothing wraps it.

### cloudflareEmailRestTransport

```ts
cloudflareEmailRestTransport({ accountId, apiToken, fetchImpl? })
```

The same Cloudflare service over its REST API, for processes with no Worker
binding, such as a Node self-host or CI. The API token needs the Email Sending
permission, and the same onboarded-domain requirement applies.

## Password reset emails

`frogcp/auth`'s `resetMailer` option takes a
`(info) => Promise<void>` receiving `{ email, resetToken, expiresAt }`.
`passwordResetEmail` adapts a mail plugin into exactly that shape, with the
link and expiry filled in:

```ts
import { authPlugin } from "frogcp/auth";
import { mailPlugin, passwordResetEmail, resendTransport } from "frogcp/mail";

const mail = mailPlugin({
  from: "Acme <noreply@acme.com>",
  transport: resendTransport({ apiKey: process.env.RESEND_API_KEY! }),
});

const auth = authPlugin({
  secret: process.env.AUTH_SECRET!,
  resetMailer: passwordResetEmail(mail, { origin: "https://app.example.com" }),
});

// createBackend({ ..., plugins: [mail, auth] })
```

`origin` is the site the reset link points at; the link becomes
`<origin>/reset?token=...`, with any trailing slash on `origin` stripped. An
optional `from` overrides the plugin's default sender for these messages only.

It accepts either a `MailPlugin` or a bare `Mailer`, so a hand-rolled mailer
works too. The two modules do not import each other; the reset-info type is
declared on both sides and your app composes them.

## Writing a transport

Because the contract is one function, a new provider is a few lines. See the
worked Resend example in [Writing a plugin](/guides/plugins/), including how
the `fetchImpl` seam lets you test it with no network.
