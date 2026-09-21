/**
 * @file Startup configuration, and failing fast when it is wrong.
 *
 * A service that starts without an introspection endpoint would answer 503 to
 * every mutation and look like an auth outage. Better to refuse to start and
 * say which variable is missing — the 2026-08-22 outage was a migrated image
 * meeting a stack that did not have its new variables yet, and a crash-loop
 * with a clear message is how that is diagnosed in one log line.
 *
 * No message here ever contains the secret's value.
 */

import { ENV_SECRET, ENV_URL } from "./messages";
import type { IntrospectionConfig } from "./types";

/** Thrown at startup. Its message names the variable and never its value. */
export class IntrospectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntrospectionConfigError";
  }
}

const required = (env: NodeJS.ProcessEnv | Record<string, string | undefined>, name: string): string => {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new IntrospectionConfigError(
      `${name} is required — refusing to start without it`
    );
  }
  return value.trim();
};

/**
 * Read {@link ENV_URL} and {@link ENV_SECRET}, or throw.
 *
 * The URL is the **full** endpoint, `/auth/v1/introspect` included, and is
 * POSTed to verbatim. This function validates it and hands it back unchanged;
 * it never appends a path, joins a suffix or takes it apart.
 */
export function loadIntrospectionConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): IntrospectionConfig {
  const url = required(env, ENV_URL);
  const secret = required(env, ENV_SECRET);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntrospectionConfigError(
      `${ENV_URL} must be an absolute URL, for example http://localhost:3005/auth/v1/introspect`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // The scheme is echoed because it is the useful half of the diagnosis and
    // carries nothing sensitive. The rest of the URL is not.
    throw new IntrospectionConfigError(
      `${ENV_URL} must use http or https, not ${parsed.protocol.replace(":", "")}`
    );
  }

  if (parsed.search.length > 0) {
    // A token never goes in a query string, and neither does anything else:
    // an endpoint URL carrying a query is a sign the secret was put there.
    throw new IntrospectionConfigError(
      `${ENV_URL} must be a plain endpoint URL with no query string`
    );
  }

  return { url, secret };
}
