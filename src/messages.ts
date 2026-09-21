/**
 * @file The five sentences, byte for byte.
 *
 * Copied from `contract.messages` in meta's `fixtures/introspection.json`
 * (vendored at test/fixtures/introspection.json). The conformance suite
 * asserts every rejection's exact message against the fixture, so these cannot
 * drift without a red test.
 *
 * The first three are the ones four services already answer with and are
 * preserved byte for byte — command-interface parses this family with one
 * parser for every backend. The last two are new with decision 21.
 */
export const MESSAGES = {
  /** 401. Nothing was presented on a route that needs a credential. */
  missingToken: "a bearer token is required",
  /** 401. Something was presented and the center did not accept it. */
  invalidSession: "invalid or expired session",
  /** 403. Generic on purpose: naming the scope advertises what to steal. */
  missingScope: "this action requires a scope this session does not carry",
  /** 500, not 403: our routing-table defect, which the caller cannot fix. */
  undeclaredRoute: "this route declares no required scope",
  /**
   * 503. Covers all five failure conditions — unreachable, timed out, non-2xx,
   * malformed body, and the center rejecting *our* caller secret. It says
   * "could not process" rather than anything about answering because in three
   * of the five the center did answer.
   */
  centerUnavailable: "the authentication service could not process this request",
} as const;

/** The header the caller secret travels in. */
export const SECRET_HEADER = "X-Introspection-Secret";

/** Environment variable holding the full introspection endpoint URL. */
export const ENV_URL = "AUTH_INTROSPECTION_URL";

/** Environment variable holding the caller secret. */
export const ENV_SECRET = "AUTH_INTROSPECTION_SECRET";

/** Client timeout for one center call. No retries, ever. */
export const DEFAULT_TIMEOUT_MS = 1000;

/** Hard cap on the center's response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
