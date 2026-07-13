/// <reference types="node" />
import type { FrogPlugin } from "frogcp";

export const VERSION = "0.0.1";

/**
 * Transactional email as a frogCP plugin.
 *
 * The kernel knows nothing about email, and plugins receive their
 * collaborators explicitly. `mailPlugin(...)` returns a `FrogPlugin` that also
 * carries its service handle: construct it once, put it in `plugins`, and hand
 * `mail.mailer` (or a purpose-built adapter like `passwordResetEmail`) to
 * whichever plugin needs to send.
 *
 *   const mail = mailPlugin({ from: "frogCP <noreply@frogcp.com>", transport: consoleTransport() });
 *   createBackend({
 *     plugins: [
 *       mail,
 *       authPlugin({ ..., resetMailer: passwordResetEmail(mail, { origin: "https://dash.frogcp.com" }) }),
 *     ],
 *   });
 *
 * A transport is how a message actually leaves the process: a small
 * `(message) => Promise<void>` value, so any provider is a few lines. See
 * `consoleTransport`, `resendTransport`, `sendEmailBindingTransport`, and
 * `cloudflareEmailRestTransport` below.
 */

/** A transactional message. `from` accepts `Name <addr@host>` or a bare address. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** How a `MailMessage` leaves the process. Implementations should throw on
 * failure; callers decide whether delivery is best-effort or fatal. */
export type MailTransport = (message: MailMessage) => Promise<void>;

/** The service handle `mailPlugin` exposes to the rest of the app. */
export interface Mailer {
  /** Sends `message`, filling `from` from the plugin's default when omitted. */
  send(message: Omit<MailMessage, "from"> & { from?: string }): Promise<void>;
}

export interface MailPluginOptions {
  /** Default sender, e.g. `"frogCP <noreply@frogcp.com>"`, used whenever a
   * `send` call does not carry its own `from`. */
  from: string;
  /** The delivery mechanism. See the transports below, or bring your own. */
  transport: MailTransport;
}

/** `FrogPlugin` plus the attached `Mailer` service handle. */
export interface MailPlugin extends FrogPlugin {
  mailer: Mailer;
}

/**
 * Builds the mail plugin. It has no entities and no routes; it logs the active
 * configuration once at boot so a deployment's logs say whether mail is real or
 * console-only, and carries the `mailer` handle other plugins compose with.
 */
export function mailPlugin(opts: MailPluginOptions): MailPlugin {
  if (!opts.from.trim()) throw new Error('mailPlugin: "from" must be a non-empty sender address');

  const mailer: Mailer = {
    async send(message) {
      await opts.transport({ from: message.from ?? opts.from, ...message });
    },
  };

  return {
    name: "mail",
    onBoot(ctx) {
      ctx.logger.info("mail: transport configured", { from: opts.from, transport: opts.transport.name || "custom" });
    },
    mailer,
  };
}

/* ============================================================================
 * Transports
 * ========================================================================= */

/**
 * Dev transport: writes the whole message to the logger or console instead of
 * sending it. Password-reset links show up in the terminal, no provider
 * account needed.
 */
export function consoleTransport(log: (line: string) => void = console.log): MailTransport {
  return async function consoleMail(message: MailMessage): Promise<void> {
    log(
      [
        "-- mail (console transport, NOT delivered) --",
        `From: ${message.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "---------------------------------------------",
      ].join("\n"),
    );
  };
}

export interface ResendTransportOptions {
  /** A https://resend.com API key (the sending domain must be verified there). */
  apiKey: string;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Resend's REST API over plain `fetch`, so it behaves identically on Node and
 * Cloudflare Workers. Delivers to any recipient. */
export function resendTransport(opts: ResendTransportOptions): MailTransport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  return async function resendMail(message: MailMessage): Promise<void> {
    const res = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) throw new Error(`resend: HTTP ${res.status} sending to ${message.to}`);
  };
}

/** The structural slice of Cloudflare Email Service's `send_email` Worker
 * binding this module needs, declared locally so it typechecks without
 * `@cloudflare/workers-types`. */
export interface SendEmailBindingLike {
  send(builder: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Cloudflare Email Service via its `send_email` Worker binding:
 * `env.EMAIL.send({from,to,subject,text})`, no MIME building. Delivers to any
 * recipient once a sending domain is onboarded; `from` must be on that domain.
 * See https://developers.cloudflare.com/email-service/
 */
export function sendEmailBindingTransport(binding: SendEmailBindingLike): MailTransport {
  return async function sendEmailBindingMail(message: MailMessage): Promise<void> {
    // The binding throws on failure (unonboarded domain, bad recipient), which
    // is exactly this transport's contract, so no wrapping is needed.
    await binding.send({ from: message.from, to: message.to, subject: message.subject, text: message.text });
  };
}

export interface CloudflareEmailRestOptions {
  /** The Cloudflare account id that has Email Sending onboarded. */
  accountId: string;
  /** An API token with Email Sending permission. */
  apiToken: string;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Cloudflare Email Service over its REST API
 * (`POST /accounts/:id/email/sending/send`), the same service as
 * `sendEmailBindingTransport` for processes without a Worker binding (Node
 * self-hosts, CI). Same onboarded sending domain requirement.
 */
export function cloudflareEmailRestTransport(opts: CloudflareEmailRestOptions): MailTransport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  return async function cloudflareEmailRestMail(message: MailMessage): Promise<void> {
    const res = await doFetch(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, text: message.text }),
      },
    );
    if (!res.ok) throw new Error(`cloudflare email: HTTP ${res.status} sending to ${message.to}`);
  };
}

/* ============================================================================
 * Purpose-built adapters
 * ========================================================================= */

/** Structurally identical to `frogcp/auth`'s `PasswordResetInfo`, declared here
 * so neither module depends on the other; the app composes them. */
export interface PasswordResetEmailInfo {
  email: string;
  resetToken: string;
  expiresAt: Date;
}

export interface PasswordResetEmailOptions {
  /** The dashboard origin reset links are minted under, e.g.
   * `https://dash.frogcp.com`. The link becomes `<origin>/reset?token=...`. */
  origin: string;
  /** Overrides the mail plugin's default sender for these messages. */
  from?: string;
}

/**
 * Adapts a `MailPlugin` (or bare `Mailer`) into the exact `resetMailer` shape
 * `frogcp/auth`'s `authPlugin` accepts: the standard reset email, with the link
 * and expiry filled in.
 */
export function passwordResetEmail(
  mail: MailPlugin | Mailer,
  opts: PasswordResetEmailOptions,
): (info: PasswordResetEmailInfo) => Promise<void> {
  const mailer = "mailer" in mail ? mail.mailer : mail;
  const origin = opts.origin.replace(/\/$/, "");
  return async ({ email, resetToken, expiresAt }) => {
    const link = `${origin}/reset?token=${encodeURIComponent(resetToken)}`;
    await mailer.send({
      to: email,
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      subject: "Reset your frogCP password",
      text:
        `Someone (hopefully you) asked to reset the password for ${email}.\n\n` +
        `Set a new password here:\n${link}\n\n` +
        `The link expires at ${expiresAt.toISOString()} (about 1 hour) and can be used once.\n` +
        `If you did not ask for this, ignore this email. Your password is unchanged.`,
    });
  };
}
