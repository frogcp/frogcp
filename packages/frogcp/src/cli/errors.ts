/**
 * Thrown for user-facing CLI errors (bad flags, bad config, bad project name).
 * The entrypoint catches it and prints `.message` alone, with no stack trace,
 * then exits non-zero. Lives in its own module so both the commands and the
 * entrypoint import it from one neutral place.
 */
export class CliError extends Error {}
