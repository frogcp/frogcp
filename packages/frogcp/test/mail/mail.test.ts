import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend } from "frogcp";
import {
  cloudflareEmailRestTransport,
  consoleTransport,
  mailPlugin,
  passwordResetEmail,
  resendTransport,
  sendEmailBindingTransport,
  type MailMessage,
} from "../../src/mail/index";

const FROM = "frogCP <noreply@frogcp.test>";

function capturingTransport(): { sent: MailMessage[]; transport: (m: MailMessage) => Promise<void> } {
  const sent: MailMessage[] = [];
  return {
    sent,
    transport: async (m) => {
      sent.push(m);
    },
  };
}

describe("mailPlugin", () => {
  it("carries a mailer that fills the default from and delegates to the transport", async () => {
    const { sent, transport } = capturingTransport();
    const mail = mailPlugin({ from: FROM, transport });

    await mail.mailer.send({ to: "a@example.com", subject: "hi", text: "body" });
    await mail.mailer.send({ to: "b@example.com", from: "Other <o@x.test>", subject: "yo", text: "body2" });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ from: FROM, to: "a@example.com", subject: "hi", text: "body" });
    expect(sent[1]?.from).toBe("Other <o@x.test>");
  });

  it("throws at construction on an empty from", () => {
    const { transport } = capturingTransport();
    expect(() => mailPlugin({ from: "  ", transport })).toThrow(/from/);
  });

  it("boots as a real FrogPlugin inside createBackend", async () => {
    const { transport } = capturingTransport();
    const mail = mailPlugin({ from: FROM, transport });
    const backend = await createBackend({
      config: defineBackend({ entities: {} }),
      adapter: nodeSqliteAdapter(":memory:"),
      plugins: [mail],
    });
    const res = await backend.fetch(new Request("http://x/api/system/health"));
    expect(res.status).toBe(200);
  });
});

describe("transports", () => {
  it("consoleTransport writes the message without sending", async () => {
    const lines: string[] = [];
    const transport = consoleTransport((l) => lines.push(l));
    await transport({ from: FROM, to: "a@example.com", subject: "s", text: "the body" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NOT delivered");
    expect(lines[0]).toContain("a@example.com");
    expect(lines[0]).toContain("the body");
  });

  it("resendTransport posts the Resend shape and throws on a non-2xx", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = resendTransport({ apiKey: "re_test", fetchImpl: okFetch });
    await transport({ from: FROM, to: "a@example.com", subject: "s", text: "b" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ from: FROM, to: ["a@example.com"], subject: "s", text: "b" });

    const failFetch = (async () => new Response(null, { status: 422 })) as typeof fetch;
    const failing = resendTransport({ apiKey: "re_test", fetchImpl: failFetch });
    await expect(failing({ from: FROM, to: "a@example.com", subject: "s", text: "b" })).rejects.toThrow(/422/);
  });

  it("sendEmailBindingTransport calls the Email Service builder API and propagates its errors", async () => {
    const seen: Array<{ from: string; to: string; subject: string; text: string }> = [];
    const okBinding = {
      async send(builder: { from: string; to: string; subject: string; text: string }) {
        seen.push(builder);
        return { messageId: "m1" };
      },
    };
    const transport = sendEmailBindingTransport(okBinding);
    await transport({ from: FROM, to: "a@example.com", subject: "s", text: "b" });
    expect(seen[0]).toEqual({ from: FROM, to: "a@example.com", subject: "s", text: "b" });

    const failBinding = {
      async send(): Promise<unknown> {
        throw new Error("domain not onboarded for sending");
      },
    };
    await expect(sendEmailBindingTransport(failBinding)({ from: FROM, to: "a@example.com", subject: "s", text: "b" })).rejects.toThrow(
      /domain not onboarded/,
    );
  });

  it("cloudflareEmailRestTransport posts the Email Service REST shape and throws on a non-2xx", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = cloudflareEmailRestTransport({ accountId: "acc123", apiToken: "tok", fetchImpl: okFetch });
    await transport({ from: FROM, to: "a@example.com", subject: "s", text: "b" });
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ from: FROM, to: "a@example.com", subject: "s", text: "b" });

    const failFetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
    const failing = cloudflareEmailRestTransport({ accountId: "acc123", apiToken: "tok", fetchImpl: failFetch });
    await expect(failing({ from: FROM, to: "a@example.com", subject: "s", text: "b" })).rejects.toThrow(/403/);
  });
});

describe("passwordResetEmail", () => {
  it("adapts a MailPlugin into frogcp/auth's resetMailer shape (link + expiry in the body)", async () => {
    const { sent, transport } = capturingTransport();
    const mail = mailPlugin({ from: FROM, transport });
    const resetMailer = passwordResetEmail(mail, { origin: "https://dash.frogcp.test/" });

    const expiresAt = new Date("2026-07-11T15:00:00.000Z");
    await resetMailer({ email: "user@example.com", resetToken: "rst_abc/+=", expiresAt });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("user@example.com");
    expect(sent[0]?.from).toBe(FROM);
    // Trailing slash on origin normalized; token URI-encoded.
    expect(sent[0]?.text).toContain("https://dash.frogcp.test/reset?token=rst_abc%2F%2B%3D");
    expect(sent[0]?.text).toContain(expiresAt.toISOString());
  });

  it("accepts a bare Mailer and a per-adapter from override", async () => {
    const { sent, transport } = capturingTransport();
    const mail = mailPlugin({ from: FROM, transport });
    const resetMailer = passwordResetEmail(mail.mailer, { origin: "https://x.test", from: "Security <sec@x.test>" });
    await resetMailer({ email: "u@example.com", resetToken: "rst_1", expiresAt: new Date() });
    expect(sent[0]?.from).toBe("Security <sec@x.test>");
  });
});
