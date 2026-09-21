/**
 * @file The vocabulary every other module speaks.
 *
 * Nothing here knows about HTTP frameworks, and nothing here knows how to
 * verify a token — that happens in exactly one process (auth-design.md
 * decision 21) and this package only asks it.
 */

/**
 * What the center says a subject is. Returned verbatim; this package never
 * derives it from the `sub` prefix, which is the one convention only
 * auth-service is allowed to know.
 */
export type Kind = "operator" | "machine";

/** The verified identity handed to a handler once a route lets a caller past. */
export interface Identity {
  /** The Clerk subject, as the center reported it. */
  readonly sub: string;
  /** The center's answer, never re-derived from {@link Identity.sub}. */
  readonly kind: Kind;
  /** `scope` split on whitespace runs, empties discarded. May be empty. */
  readonly scopes: readonly string[];
}

/**
 * What a route declares it needs.
 *
 * - `"none"` — no credential declared. On a `GET` that means a public route
 *   an anonymous visitor may read; on any other method it is a defect and the
 *   route answers 500 before the `Authorization` header is read.
 * - `"session"` — any verified session, carrying any scopes at all, including
 *   none.
 * - anything else — a scope literal such as `"fleet:control"` that the
 *   session must carry.
 *
 * `"none"` and `"session"` are therefore reserved and cannot be scope names.
 * No scope in this system contains a `:`-less bare word, so the collision is
 * theoretical; it is called out because the type cannot express it.
 */
export type RouteRequirement = "none" | "session" | (string & {});

/** The verdict for one inbound request, before any framework touches it. */
export type Decision =
  | { readonly outcome: "proceed"; readonly identity: Identity | null }
  | {
      readonly outcome: "reject";
      readonly status: 401 | 403 | 500 | 503;
      readonly message: string;
    };

/** st-gateway's queue lanes. It picks one and never rejects anything. */
export type Lane = "interactive" | "background";

/** Where the center is and what secret we present to it. */
export interface IntrospectionConfig {
  /**
   * The **full** endpoint URL, `/auth/v1/introspect` included, POSTed to
   * verbatim. Never a base URL and never joined with a suffix
   * (token-introspection.md, "Conformance").
   */
  readonly url: string;
  /** The caller secret sent as `X-Introspection-Secret`. Never logged. */
  readonly secret: string;
  /** Overall budget for one center call. Defaults to 1000 ms. */
  readonly timeoutMs?: number;
  /**
   * Hard cap on the center's response body, in bytes. Defaults to 64 KiB; a
   * conforming answer is well under 200. Anything larger is treated as a
   * center that could not be understood.
   */
  readonly maxResponseBytes?: number;
}
