/**
 * Wraps a failed `import(DRIZZLE_KIT_API_SPECIFIER)` in an error that says what
 * to do about it. drizzle-kit can be missing for several reasons (bundled away
 * for Workers, never installed, stripped by a bundler) and the underlying
 * message for each is opaque, so translate the load failure itself rather than
 * testing for a runtime.
 *
 * Only call this when the import rejected. An error thrown from inside
 * drizzle-kit after it loaded is a real migration failure and must propagate.
 */
export function drizzleKitUnavailable(cause: unknown): Error {
  return new Error(
    "automatic migration needs drizzle-kit at runtime, and it could not be loaded. " +
      "It is not available in bundled or edge environments such as Cloudflare Workers.\n" +
      "Boot with `migrate: false` and apply the schema out of band. " +
      "On D1 that is `wrangler d1 execute <database> --file=schema.sql`.",
    { cause },
  );
}
