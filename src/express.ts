/**
 * @file Express 4 adapter.
 *
 * Express is a **development dependency of this repository only**: nothing
 * here imports it at runtime *or at type level*. The three interfaces below
 * are the minimum shape the adapter touches, declared locally, so the shipped
 * `.d.ts` mentions no package a consumer might not have installed — a consumer
 * with `skipLibCheck: false` and no `@types/express` typechecks against this
 * file, which is the claim CI now proves with two separate tarball probes.
 * Real Express `Request`/`Response`/`RequestHandler` values are structurally
 * assignable in both directions, so `app.use(auth.guard(…))` needs no cast.
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
 *
 * **The guard trusts `req.method`.** Any method-override middleware must be
 * mounted *before* it, or a `POST` arrives here as whatever the override said
 * and default-deny is decided about the wrong method. This package ignores
 * `X-HTTP-Method-Override` itself and always will; see the README.
 */

import type { Introspector } from "./center";
import type { Authorizer } from "./core";
import { createAuthorizer } from "./core";
import { MESSAGES } from "./messages";
import type {
  Decision,
  Identity,
  IntrospectionConfig,
  Kind,
  RouteRequirement,
} from "./types";

/**
 * The part of an Express `Request` this adapter reads. A real `Request`
 * satisfies it; declaring it locally keeps `express` out of the public types.
 */
export interface RequestLike {
  /** The HTTP method, as the framework parsed it. */
  readonly method: string;
  /**
   * The path, without the query string — Express's `req.path`. Here because
   * every router-level resolver in the three consumers keys on
   * `` `${req.method} ${req.path}` `` and would otherwise need a cast.
   */
  readonly path: string;
  /**
   * One request header, case-insensitively. Express returns the joined value
   * for a repeated header and an array only for `set-cookie`; both shapes are
   * accepted here so a real `Request` is assignable without a cast.
   */
  header(name: string): string | string[] | undefined;
}

/** The part of an Express `Response` this adapter writes. */
export interface ResponseLike {
  locals: Record<string, unknown>;
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

/** Express's `next`. An error argument makes Express fail the request. */
export type NextLike = (err?: unknown) => void;

/** Structurally an Express `RequestHandler`, without naming one. */
export type HandlerLike = (
  req: RequestLike,
  res: ResponseLike,
  next: NextLike
) => void;

/** `res.locals` key holding the verified identity, or null for a visitor. */
export const LOCALS_IDENTITY = "identity";
/** `res.locals` key holding the subject — automation-service's `detail.actor`. */
export const LOCALS_ACTOR = "actor";
/** `res.locals` key holding what the route declared. */
export const LOCALS_REQUIRES = "authRequires";

/**
 * The verified identity for this request, or null when the caller is a
 * visitor. This and {@link kindOf} / {@link actorOf} / {@link hasScope} are
 * the **only** supported accessors.
 *
 * There is deliberately no `res.locals.kind`. It existed and was removed: a
 * second copy of the center's answer is a second thing to keep true, and the
 * one failure this package exists to prevent is a service deriving `kind`
 * itself. One source of truth — `res.locals.identity` — and `kindOf()` reads
 * it.
 */
export const identityOf = (res: ResponseLike): Identity | null =>
  (res.locals[LOCALS_IDENTITY] as Identity | null | undefined) ?? null;

/** The subject, or null for a visitor. */
export const actorOf = (res: ResponseLike): string | null =>
  identityOf(res)?.sub ?? null;

/**
 * The center's `kind`, or null for a visitor. Never derived from the subject:
 * a fence written as `kindOf(res) === "machine"` is the supported spelling.
 */
export const kindOf = (res: ResponseLike): Kind | null =>
  identityOf(res)?.kind ?? null;

/** True when this request carries a verified session holding `scope`. */
export const hasScope = (res: ResponseLike, scope: string): boolean =>
  identityOf(res)?.scopes.includes(scope) ?? false;

/** Maps a request to what its route declares. */
export type RequirementResolver = (req: RequestLike) => RouteRequirement;

export interface ExpressAuth {
  /**
   * Router-level middleware. Mount once with `router.use(auth.guard(...))`.
   *
   * `resolve` is either a fixed requirement or a function of the request. A
   * resolver that falls back to `"none"` is what makes an unguarded mutating
   * route answer 500 rather than run.
   *
   * On a `HEAD`, `resolve` is called with `method` reading `"GET"`, because
   * `HEAD /x` is the same route as `GET /x` and Express dispatches it to that
   * handler. A table keyed `"GET /cooldown"` therefore governs a `HEAD
   * /cooldown` as well — without this, a `HEAD` would miss the table, fall
   * back to `"none"` and be served without the credential the route declared.
   */
  guard(resolve: RouteRequirement | RequirementResolver): HandlerLike;
  /** Per-route form of {@link ExpressAuth.guard}. */
  declare(requires: RouteRequirement): HandlerLike;
  /** `declare(scope)`, spelled the way the services that exist today spell it. */
  requireScope(scope: string): HandlerLike;
  /** Any verified session, carrying any scopes at all, including none. */
  requireSession(): HandlerLike;
  /**
   * Declares a route public. On a safe method (`GET`, `HEAD`, `OPTIONS`) an
   * anonymous caller proceeds as a visitor; on a mutating method this is the
   * defect that answers 500.
   */
  allowPublic(): HandlerLike;
}

/** Writes a rejection in the family's `{"error":{"message":…}}` envelope. */
const sendRejection = (
  res: ResponseLike,
  status: number,
  message: string
): void => {
  res.status(status).json({ error: { message } });
};

const apply = (res: ResponseLike, decision: Decision, next: NextLike): void => {
  if (decision.outcome === "reject") {
    sendRejection(res, decision.status, decision.message);
    return;
  }
  res.locals[LOCALS_IDENTITY] = decision.identity;
  res.locals[LOCALS_ACTOR] = decision.identity?.sub ?? null;
  next();
};

/**
 * The same request, reading `GET` as its method.
 *
 * Only for handing to a {@link RequirementResolver}: `HEAD /x` is routed to
 * the `GET /x` handler by Express, so what `GET /x` declared is what governs
 * it. Nothing is mutated — the real `req.method` the handlers and the policy
 * see is untouched, so a `HEAD` is still answered as a `HEAD`.
 */
const asGet = (req: RequestLike): RequestLike =>
  new Proxy(req, {
    get(target, property) {
      if (property === "method") return "GET";
      const value = Reflect.get(target, property, target) as unknown;
      // Bound to the real request: Express's `path`/`header` read internals
      // that a proxy receiver would not satisfy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as RequestLike;

export function createExpressAuth(
  source: IntrospectionConfig | Introspector | Authorizer
): ExpressAuth {
  const authorizer: Authorizer =
    "authorize" in source ? source : createAuthorizer(source);

  const handlerFor = (resolve: RequirementResolver): HandlerLike => {
    return (req, res, next) => {
      let requires: RouteRequirement;
      try {
        requires =
          req.method.toUpperCase() === "HEAD" ? resolve(asGet(req)) : resolve(req);
      } catch {
        // A resolver that throws has told us nothing about this route, so we
        // know nothing about what it needs. Falling back to `"none"` would
        // serve every safe method of every route anonymously the moment the
        // route table threw; falling back to `"session"` would serve them to
        // anyone with any token at all. Neither is a thing to guess. It fails
        // closed on EVERY method, with the same 500 as a route that declares
        // nothing, because it is the same class of defect: ours, and one the
        // caller cannot fix.
        res.locals[LOCALS_REQUIRES] = null;
        sendRejection(res, 500, MESSAGES.undeclaredRoute);
        return;
      }
      res.locals[LOCALS_REQUIRES] = requires;

      authorizer
        .authorize({
          method: req.method,
          requires,
          // A repeated header arrives joined; `bearerFrom` reads that as no
          // credential rather than picking one of the two.
          authorization: headerValue(req, "Authorization"),
        })
        .then((decision) => apply(res, decision, next))
        // The authorizer is written not to reject; if a host's injected
        // introspector does, the request must still fail closed rather than
        // hand Express an unhandled promise. `next(err)` and not `next()`:
        // passing no error would run the handler the guard just failed to
        // authorize.
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

/** One header as a single string, or null. An array is joined as Node joins. */
const headerValue = (req: RequestLike, name: string): string | null => {
  const value = req.header(name);
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
};
