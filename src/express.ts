/**
 * @file Express 4 adapter.
 *
 * Express is an **optional peer, types only**: nothing here is imported at
 * runtime, so a host that does not use Express pays nothing and the package
 * keeps zero runtime dependencies.
 *
 * Two shapes are supported because the three consumers have two shapes between
 * them:
 *
 * - **Router-level, keyed on the request** — `guard(resolve)`, mounted once
 *   with `router.use(...)`. This is the only form that gives real default-deny,
 *   because a resolver that returns `"none"` for anything it does not
 *   recognise makes an unguarded `POST` answer 500 instead of running.
 *   fleet-service mounts exactly this.
 * - **Per-route** — `declare(requires)` / `requireScope` / `requireSession` /
 *   `allowPublic`, attached to individual routes, which is how
 *   automation-service is written.
 *
 * They compose: `declare()` records its requirement on `res.locals` before it
 * enforces it, so a router-level `guard()` mounted in front can read back what
 * a route asked for. What per-route guards **cannot** do on their own is
 * default-deny — a route with no guard has nothing to run — so a service using
 * them must still mount `guard()` router-level. That is stated in the README
 * rather than hidden, because it is the whole point of decision 21.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Introspector } from "./center";
import type { Authorizer } from "./core";
import { createAuthorizer } from "./core";
import type {
  Decision,
  Identity,
  IntrospectionConfig,
  Kind,
  RouteRequirement,
} from "./types";

/** `res.locals` key holding the verified identity, or null for a visitor. */
export const LOCALS_IDENTITY = "identity";
/** `res.locals` key holding the subject — automation-service's `detail.actor`. */
export const LOCALS_ACTOR = "actor";
/** `res.locals` key holding the center's `kind`. The knob-class fence reads it. */
export const LOCALS_KIND = "kind";
/** `res.locals` key holding what the route declared. */
export const LOCALS_REQUIRES = "authRequires";

/** The verified identity for this request, or null when the caller is a visitor. */
export const identityOf = (res: Response): Identity | null =>
  (res.locals[LOCALS_IDENTITY] as Identity | null | undefined) ?? null;

/** The subject, or null for a visitor. */
export const actorOf = (res: Response): string | null =>
  identityOf(res)?.sub ?? null;

/**
 * The center's `kind`, or null for a visitor. Never derived from the subject:
 * a fence written as `kindOf(res) === "machine"` is the supported spelling.
 */
export const kindOf = (res: Response): Kind | null => identityOf(res)?.kind ?? null;

/** True when this request carries a verified session holding `scope`. */
export const hasScope = (res: Response, scope: string): boolean =>
  identityOf(res)?.scopes.includes(scope) ?? false;

/** Maps a request to what its route declares. */
export type RequirementResolver = (req: Request) => RouteRequirement;

export interface ExpressAuth {
  /**
   * Router-level middleware. Mount once with `router.use(auth.guard(...))`.
   *
   * `resolve` is either a fixed requirement or a function of the request. A
   * resolver that falls back to `"none"` is what makes an unguarded mutating
   * route answer 500 rather than run.
   */
  guard(resolve: RouteRequirement | RequirementResolver): RequestHandler;
  /** Per-route form of {@link ExpressAuth.guard}. */
  declare(requires: RouteRequirement): RequestHandler;
  /** `declare(scope)`, spelled the way the services that exist today spell it. */
  requireScope(scope: string): RequestHandler;
  /** Any verified session, carrying any scopes at all, including none. */
  requireSession(): RequestHandler;
  /**
   * Declares a route public. On a `GET` an anonymous caller proceeds as a
   * visitor; on any other method this is the defect that answers 500.
   */
  allowPublic(): RequestHandler;
}

/** Writes a rejection in the family's `{"error":{"message":…}}` envelope. */
const sendRejection = (
  res: Response,
  status: number,
  message: string
): void => {
  res.status(status).json({ error: { message } });
};

const apply = (res: Response, decision: Decision, next: NextFunction): void => {
  if (decision.outcome === "reject") {
    sendRejection(res, decision.status, decision.message);
    return;
  }
  res.locals[LOCALS_IDENTITY] = decision.identity;
  res.locals[LOCALS_ACTOR] = decision.identity?.sub ?? null;
  res.locals[LOCALS_KIND] = decision.identity?.kind ?? null;
  next();
};

export function createExpressAuth(
  source: IntrospectionConfig | Introspector | Authorizer
): ExpressAuth {
  const authorizer: Authorizer =
    "authorize" in source ? source : createAuthorizer(source);

  const handlerFor = (resolve: RequirementResolver): RequestHandler => {
    return (req, res, next) => {
      let requires: RouteRequirement;
      try {
        requires = resolve(req);
      } catch {
        // A resolver that throws is the same class of defect as a route that
        // declares nothing, and gets the same answer rather than a stack
        // trace: never fail open.
        requires = "none";
      }
      res.locals[LOCALS_REQUIRES] = requires;

      authorizer
        .authorize({
          method: req.method,
          requires,
          authorization: req.header("Authorization") ?? null,
        })
        .then((decision) => apply(res, decision, next))
        // The authorizer is written not to reject; if a host's injected
        // introspector does, the request must still fail closed rather than
        // hand Express an unhandled promise.
        .catch(() => next(new Error("introspection failed")));
    };
  };

  return {
    guard: (resolve) =>
      handlerFor(typeof resolve === "function" ? resolve : () => resolve),
    declare: (requires) => handlerFor(() => requires),
    requireScope: (scope) => handlerFor(() => scope),
    requireSession: () => handlerFor(() => "session"),
    allowPublic: () => handlerFor(() => "none"),
  };
}
