import { describe, it, expect } from "vitest";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { hashPassword, verifyPassword } from "../../src/auth/password";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

describe("hashPassword / verifyPassword", () => {
  it("round-trips: verifyPassword(pw, hashPassword(pw)) is true", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different hash (and salt) for the same password on repeated calls", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    const [, , saltA] = a.split("$");
    const [, , saltB] = b.split("$");
    expect(saltA).not.toBe(saltB);
    // ...but both still verify against the original password.
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("matches the exact stored format: scrypt$N=32768,r=8,p=1$<saltB64>$<hashB64>", async () => {
    const stored = await hashPassword("format check");
    expect(stored).toMatch(/^scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
  });

  it("rejects a tampered hash segment", async () => {
    const stored = await hashPassword("tamper me");
    const segments = stored.split("$");
    const hashB64 = segments[3] as string;
    // Flip the first base64 char to something else (valid base64, wrong value).
    const flipped = (hashB64[0] === "A" ? "B" : "A") + hashB64.slice(1);
    segments[3] = flipped;
    const tampered = segments.join("$");
    expect(await verifyPassword("tamper me", tampered)).toBe(false);
  });

  it("rejects a tampered salt segment", async () => {
    const stored = await hashPassword("tamper salt");
    const segments = stored.split("$");
    const saltB64 = segments[2] as string;
    const flipped = (saltB64[0] === "A" ? "B" : "A") + saltB64.slice(1);
    segments[2] = flipped;
    const tampered = segments.join("$");
    expect(await verifyPassword("tamper salt", tampered)).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["wrong scheme", "bcrypt$N=32768,r=8,p=1$c2FsdA==$aGFzaA=="],
    ["missing segments", "scrypt$N=32768,r=8,p=1$c2FsdA=="],
    ["too many segments", "scrypt$N=32768,r=8,p=1$c2FsdA==$aGFzaA==$extra"],
    ["missing params", "scrypt$$c2FsdA==$aGFzaA=="],
    ["params missing a key", "scrypt$N=32768,r=8$c2FsdA==$aGFzaA=="],
    ["non-numeric param", "scrypt$N=abc,r=8,p=1$c2FsdA==$aGFzaA=="],
    ["bad base64 salt", "scrypt$N=32768,r=8,p=1$not-base64!!!$aGFzaA=="],
    ["bad base64 hash", "scrypt$N=32768,r=8,p=1$c2FsdA==$not-base64!!!"],
  ])("malformed stored string (%s) resolves to false without throwing", async (_label, stored) => {
    await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
  });

  it("hostile oversized segments are rejected as false without decoding (DoS guard)", async () => {
    const huge = "A".repeat(200000);
    await expect(verifyPassword("pw", `scrypt$N=32768,r=8,p=1$${huge}$${huge}`)).resolves.toBe(false);
    // Each cap individually: oversized salt, oversized hash, oversized params.
    await expect(verifyPassword("pw", `scrypt$N=32768,r=8,p=1$${huge}$aGFzaA==`)).resolves.toBe(false);
    await expect(verifyPassword("pw", `scrypt$N=32768,r=8,p=1$c2FsdA==$${huge}`)).resolves.toBe(false);
    await expect(verifyPassword("pw", `scrypt$N=32768,r=8,p=1,${"x=1,".repeat(100)}z=1$c2FsdA==$aGFzaA==`)).resolves.toBe(false);
  });

  it("parses N/r/p out of the stored string rather than assuming today's constants", async () => {
    // Craft a hash with different (smaller) cost parameters than hashPassword
    // uses today, in the exact stored format, and confirm verifyPassword
    // still derives with THOSE parameters (not the hardcoded N=32768 ones).
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const params = { N: 16384, r: 4, p: 2 };
    const derived = await scryptAsync("legacy pw", salt, { ...params, dkLen: 32 });
    const stored = `scrypt$N=${params.N},r=${params.r},p=${params.p}$${toBase64(salt)}$${toBase64(derived)}`;

    expect(await verifyPassword("legacy pw", stored)).toBe(true);
    expect(await verifyPassword("not the pw", stored)).toBe(false);
  });
});
