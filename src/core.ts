/**
 * @file The policy, with no framework anywhere near it.
 *
 * This is the twenty-four calling-service cases of
 * `meta/fixtures/introspection.json` and nothing else. The Express adapter is
 * a thin translation on top; a `mux` wrapper or a servlet filter would be
 * another. What is fixed is the answer, the request to the center and the call
 * count — everything the fixture can observe from outside.
 */

import type { CenterAnswer, Introspector } from "./center";
import { createIntrospector } from "./center";
import { MESSAGES } from "./messages";
import type { Decision, IntrospectionConfig, RouteRequirement } from "./types";

/** One inbound request, reduced to the three things the policy reads. */
export interface InboundRequest {
  /** The HTTP method, any case. Only `GET` is exempt from default-deny. */
  readonly method: string;
  /** What the route declares it needs. */
  readonly requires: RouteRequirement;
  /** The raw `Authorization` header, or null/undefined when absent. */
  readonly authorization?: string | null;
}

/**
 * Pull the bearer token out of an `Authorization` header.
 *
 * The scheme is matched case-insensitively and anything else — `Basic …`, a
 * bare token, an empty value — reads as no credential at all, exactly as all
 * five verifiers live today do. Forwarding a non-bearer value to the center
 * would turn a 401 into a 503 the first time the center was slow.
 */
export const bearerFrom = (header: string | null | undefined): string | null => {
  if (header === null || header === undefined) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join("");
  return token.length > 0 ? token : null;
};

const reject = (
  status: 401 | 403 | 500 | 503,
  message: string
): Decision => ({ outcome: "reject", status, message });

/** Decides what happens to one inbound request. */
export interface Authorizer {
  authorize(request: InboundRequest): Promise<Decision>;
}

/**
 * Apply the policy to an answer we already have. Split out so the Express
 * adapter and the tests share one copy of the tail of the rules.
 */
const decideFrom = (answer: CenterAnswer, requires: RouteRequirement): Decision => {
  if (answer.state === "unavailable") {
    return reject(503, MESSAGES.centerUnavailable);
  }
  if (answer.state === "inactive") {
    // On every method, including a GET that would have been served
    // anonymously. A bad credential is never downgraded to a visitor.
    return reject(401, MESSAGES.invalidSession);
  }

  const { identity } = answer;
  if (requires === "none" || requires === "session") {
    // `session` is a tier: a verified session carrying no scopes at all is a
    // guest operator who may watch but not act, and is allowed through.
    return { outcome: "proceed", identity };
  }
  if (!identity.scopes.includes(requires)) {
    // 403, not 401 — the session is valid, so re-authenticating would loop.
    // The message must not name the scope.
    return reject(403, MESSAGES.missingScope);
  }
  return { outcome: "proceed", identity };
};

/**
 * Build the authorizer over a live center, or over an injected
 * {@link Introspector} when a host wants to supply its own transport.
 */
export function createAuthorizer(
  source: IntrospectionConfig | Introspector
): Authorizer {
  const introspector: Introspector =
    "introspect" in source ? source : createIntrospector(source);

  return {
    async authorize(request: InboundRequest): Promise<Decision> {
      // Rule order is the rule. Default-deny is settled BEFORE the
      // Authorization header is read, so a valid token, an expired one and
      // none at all all get the same answer: the credential a caller did or
      // did not bring says nothing about a route that declares nothing.
      const isGet = request.method.toUpperCase() === "GET";
      if (!isGet && request.requires === "none") {
        // 500 and not 403: our own routing-table defect. automation-service
        // maps a 403 to a terminal `credentials` verdict and would abandon a
        // target over a bug the operator can never fix. The center is not
        // called — a route that can never be authorized has nothing to verify.
        return reject(500, MESSAGES.undeclaredRoute);
      }

      const token = bearerFrom(request.authorization);
      if (token === null) {
        if (request.requires === "none") {
          // A public GET with no credential. Nothing to introspect, so the
          // center is not touched: doing so would put a synchronous
          // dependency in front of every public page load.
          return { outcome: "proceed", identity: null };
        }
        return reject(401, MESSAGES.missingToken);
      }

      return decideFrom(await introspector.introspect(token), request.requires);
    },
  };
}
