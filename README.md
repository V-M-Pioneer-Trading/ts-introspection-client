# @v-m-pioneer-trading/introspection-client

The TypeScript half of "one verifier". [auth-design decision 21][d21] makes
auth-service the only component that verifies a token; everyone else asks it
what the token carries and compares the answer against what their own route
declared. This package is that client for the three Node services
(fleet-service, automation-service, st-gateway).

Its behaviour is not described here but *fixed* by
[`fixtures/introspection.json`][fixture] in `meta` — thirty-five conditions for
a calling service and ten for st-gateway's queue lane, each with the center's
response and the exact status, message, identity and call count expected. It is
vendored into `test/fixtures/`, and the conformance suite drives all forty-five
cases against a real local HTTP stub.

Zero runtime dependencies and **no peer dependencies at all** — not even
Express, whose types are declared locally, so a consumer with
`skipLibCheck: false` and no `@types/express` typechecks this package with
nothing installed. CommonJS plus `.d.ts`, Node >= 18. There is no registry: a
`v*` tag attaches the tarball to a GitHub Release and consumers install that
URL, which `package-lock.json` records with an integrity hash, so the Docker
build needs no token and no git.

```sh
npm install https://github.com/V-M-Pioneer-Trading/ts-introspection-client/releases/download/v1.0.0/v-m-pioneer-trading-introspection-client-1.0.0.tgz
```

## Quick start

```ts
import express from "express";
import {
  actorOf,
  createExpressAuth,
  loadIntrospectionConfig,
  notFound,
  secured,
} from "@v-m-pioneer-trading/introspection-client";

const auth = createExpressAuth(loadIntrospectionConfig()); // throws, naming a missing env var
const app = secured(express());
const api = secured(express.Router());

api.get("/health", auth.allowPublic(), (_req, res) => res.json({ status: "ok" }));
api.get("/targets", auth.requireSession(), listTargets);
api.post("/targets", auth.requireScope("fleet:control"), (req, res) =>
  res.json({ by: actorOf(res) })
);

app.use("/api/automation/v1", api);
app.use(notFound((_req, res) => res.status(404).json({ error: { message: "not found" } })));
```

The declaration is the route's **first** handler. Leave it off, put it second,
or write two, and the process does not start, with a message naming the route
and listing the three spellings.

## Security model

**P1. A route with no declaration is never served — on any method, including
`GET`, `HEAD` and `OPTIONS`.** "Public" is a thing a route says out loud with
`allowPublic()`, never a thing that happens because a lookup missed. A
`guard()` resolver returning `undefined` or throwing is *undeclared*, which is
`500 this route declares no required scope`, decided before the `Authorization`
header is read and without calling the center. There is no fallback to
`"none"`.

> This is an **adapter** rule about a missing declaration, not the fixture's
> `requires: "none"`, which is a route that *declared* no credential is needed.
> "Undeclared" has no representation in the fixture at all.

**P2. Route matching is Express's job.** Declarations live at registration, so
Express's own matcher binds a requirement to the same route it binds the
handler to: a prefix-mounted router, a trailing slash, a case-variant path and
a `:parameter` never become a string this package looks up. A `guard()`
resolver is handed `{ method }` and nothing else for the same reason — inside a
`use` mount no route has matched yet, so any path it reconstructed would be a
second, worse matcher.

**P3. Position is part of the declaration, and there is exactly one.** Express
runs a route's handlers in registration order, so a declaration behind a
handler is a handler that already answered. Only a `passthrough()` may precede
one. Two declarations are refused outright.

**P4. A declared requirement is enforced for every method Express dispatches to
the route.** `HEAD` reaches its `GET` route's declaration because Express
dispatches it there, so a credential-free `HEAD` on a guarded route is the same
`401` as a `GET`; an `app.all` route answers `OPTIONS` with the real handler,
so its declaration governs that too. The safe methods are exempt from
**default-deny** — a route that declared `"none"` serves them to a visitor —
and from nothing else. An `OPTIONS` whose path matches but whose method does
not is answered by Express itself, before any layer on the route runs; see the
disclosure below.

**P5. CORS preflight works because `cors()` terminates it**, not because the
guard waves it through, so **mount `cors()` first**. Mounted after, an Express
router answers the preflight itself with a `200`, an `Allow` header and no
`Access-Control-Allow-Origin`, and the browser fails it. A test pins both
orders, so the remedy is known to be the mount order rather than an exemption
for `OPTIONS`.

**P6. One inbound request asks the center at most once.** A router-level
`guard()` and a route's own declaration both enforce — the stricter effectively
wins, because each compares the same answer against its own requirement — but
the answer is memoized for the life of the response, under a module-private
Symbol on `res.locals`, keyed on the exact `Authorization` header value. It is
never shared between requests: a process-wide cache would be a second
verification path, would make revocation meaningless for its lifetime, and
would hand one caller's identity to the next caller presenting the same header.

### What this package does **not** protect

A fence whose gaps are unknown is worse than no fence.

- **Anything mounted before the guard or the secured router.** It answers
  without ever reaching them. A body parser is fine there; a route is not.
- **Handlers registered on an app or router that was never `secured()`.**
  (A reference taken *before* `secured()` is fine: it patches in place, so
  every alias goes through the patched methods.)
- **A Route obtained around the patch** — `Object.getPrototypeOf(router).route
  .call(router, "/x").get(handler)` — and a layer pushed straight onto
  `router.stack`. Both reach Express's internals without passing through any
  method this package replaced. Closing them would mean mutating Express's own
  prototypes.
- **The existence of a route, on an automatic `OPTIONS`.** Express replies
  before any layer on the route runs, so no handler executes and nothing is
  authorized away — but the path and its method list are disclosed to an
  anonymous caller. A route registered with `app.all` or `.options` does not
  have this property, because Express dispatches to it and the declaration
  runs.
- **What a `passthrough()` actually does.** It is the author's word that a
  handler is middleware and will never answer. That is why it takes a reason.
- **A second copy of this package in one process.** `secured()` would not
  recognise the other copy's declarations — a refusal to start, not a hole.
- **Anything after the guard runs.** A knob fence, a tenant check, an ownership
  check are the handler's.
- **The method, if something upstream rewrote it.** `X-HTTP-Method-Override` is
  ignored here and always will be; mount any override middleware **before** the
  guard, or the requirement is decided about one method and the route runs as
  another.

## Migrating an Express app

Every construct the three services contain, in the spelling this package
accepts.

```ts
const app = secured(express());

// 1. Health routes: public is declared out loud, and a bare `app.get` is not.
app.get("/health", auth.allowPublic(), health);
app.get("/api/fleet/health", auth.allowPublic(), health);

// 2. A generated router (tsoa) has no call site for a declaration, so it gets
//    a router-level guard. The resolver is a function of the METHOD alone.
const api = express.Router();
api.use(auth.guard(({ method }) => (method === "GET" ? "session" : "fleet:control")));
RegisterRoutes(api);
app.use("/api/fleet/v1", api);

// 3. A DECLARED MOUNT: the leading declaration covers everything after it, so
//    third-party middleware that cannot be branded needs no wrapper.
app.use("/api/fleet/swagger", auth.allowPublic(), swaggerUi.serve, swaggerUi.setup(spec));
app.use("/assets", auth.allowPublic(), express.static(assetDir));
app.use("/proxy", auth.requireSession(), express.raw({ type: "*/*", limit: "5mb" }), proxy);

// 4. Middleware that never answers says so, once, with a reason.
app.use(passthrough(express.json(), "parses bodies; never answers"));
app.use(passthrough(cors(corsOptions), "answers preflights; never serves a resource"));

// 5. The terminal JSON 404. It serves no resource, so it needs no credential
//    and never asks the center — and nothing but an error handler may follow it.
app.use(notFound((_req, res) => res.status(404).json({ error: { message: "not found" } })));

// 6. Error handlers (arity 4) are accepted as they are: Express invokes such a
//    layer only with an error already in hand, so it can never serve a route.
app.use((err, _req, res, _next) => res.status(500).json({ error: { message: "internal" } }));
```

st-gateway is the one consumer that does **not** secure its app: `/proxy`
forwards anonymous mutations by design (`POST /register` carries the caller's
own account token, and auth-service polls `GET /` with no credential), and this
package has no spelling for "a mutating route that needs no credential" —
`allowPublic()` answers `500` there, deliberately. The gateway uses
`createLaneDeriver` only; the declared mount above is what it would write if it
ever authorized.

### Reading the identity

`identityOf(res)`, `actorOf(res)`, `kindOf(res)`, `hasScope(res, scope)` and
`requirementOf(res)` are the **only** accessors. The values live under
module-private Symbols, so there is no `res.locals` key to read instead — and
none of it appears in `Object.keys(res.locals)` or a `JSON.stringify` of it.
There is deliberately no second copy of `kind`: a knob fence is
`kindOf(res) === "machine"`, never a look at the `sub` prefix.

## Reference

### API

| Export | What it is |
|---|---|
| `createExpressAuth(config \| introspector \| authorizer)` | `requireScope(scope)`, `requireSession()`, `allowPublic()`, `guard(requirement \| resolver)` |
| `secured(routerOrAppOrRoute)` | Patches in place; enforces the registration rules. Idempotent |
| `passthrough(handler, why)` | Brands middleware that never answers |
| `notFound(handler)` | Brands the terminal 404; only an error handler may follow it |
| `identityOf` / `actorOf` / `kindOf` / `hasScope` / `requirementOf` | The accessors |
| `createAuthorizer(config \| introspector)` | The framework-agnostic policy: `authorize({ method, requires, authorization })` |
| `createLaneDeriver(config \| introspector)` | st-gateway's lane policy |
| `createIntrospector(config)`, `splitScopes`, `bearerFrom`, `isSafeMethod` | The pieces underneath |
| `loadIntrospectionConfig(env?)`, `IntrospectionConfigError` | Startup validation |
| `MESSAGES`, `SECRET_HEADER`, `ENV_URL`, `ENV_SECRET`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_RESPONSE_BYTES` | Constants |

`requireScope` throws at startup for `""`, whitespace, `"none"` and
`"session"`: the last two are the reserved words for the other two intents, and
spelled as a scope each read as a demand while silently producing its opposite.

### Behaviour

Rows are in evaluation order, and the first is first for a reason.

| Situation | Answer | Center called |
|---|---|---|
| **Mutating** route declaring `"none"` | `500` `this route declares no required scope` | **no** |
| An **undeclared** route, on any method | `500` `this route declares no required scope` | **no** |
| No `Authorization`, **safe** method declaring `"none"` | proceeds as a visitor, identity `null` | **no** |
| `Authorization` that is not `Bearer <something>` | `401` `a bearer token is required` | **no** |
| No `Authorization`, route declaring a session or a scope | `401` `a bearer token is required` | **no** |
| `{"active": false}` | `401` `invalid or expired session`, on **every** method | yes |
| Active, route declares `"session"` | proceeds, even with no scopes at all | yes |
| Active, route's scope missing | `403` `this action requires a scope this session does not carry` — the scope is **not** named | yes |
| Active, route's scope present | proceeds with `{sub, kind, scopes}` | yes |
| Center unreachable, timed out, non-2xx, malformed, or rejecting our secret | `503` `the authentication service could not process this request` | yes |

Every rejection uses the `{"error":{"message":…}}` envelope. Methods and the
bearer scheme are compared **case-insensitively**; scope literals **exactly** —
not by prefix, not by namespace walk, not case-folded — so `fleet:control:read`
and `FLEET:CONTROL` both fail a route requiring `fleet:control`. `scope` is
split on whitespace **runs** with empties discarded, matching
`strings.Fields`, `/\s+/` and `\s+` in the other implementations. `kind` is the
center's answer, used verbatim. `GET`, `HEAD` and `OPTIONS` are RFC 9110
§9.2.1's safe methods (`meta` fixture `version: 2`, owner's delegate
2026-09-21).

### Environment

| Variable | Meaning |
|---|---|
| `AUTH_INTROSPECTION_URL` | The **full** endpoint URL, `/auth/v1/introspect` included. POSTed to verbatim: never a base URL, never joined with a suffix |
| `AUTH_INTROSPECTION_SECRET` | The caller secret, sent as `X-Introspection-Secret`. Never the vault's `AUTH_SERVICE_SHARED_SECRET` |

Both are required. A blank value, a non-`http(s)` URL, a URL with a query
string, or a missing `globalThis.fetch` all refuse to start — the alternative
being a `503` on every credentialed request that reads as an auth outage — and
no message ever contains the secret.

### Lane policy — st-gateway's shape

A separate export, so nothing adopts it by accident. It never rejects, never
throws and never answers `503`: anything other than an active `operator` is
`background`, including a center that does not answer, because a gateway that
failed closed would take the public read surface down with auth-service.

```ts
const deriver = createLaneDeriver({ ...config, timeoutMs: 250 });
const lane = await deriver.derive(req.header("Authorization")); // "interactive" | "background"
```

**It awaits the center**, so a *hanging* one adds up to `timeoutMs` to every
**credentialed** request the gateway proxies; anonymous requests are unaffected,
since nothing to introspect keeps the center off the hot path of the public map.
`timeoutMs` defaults to 1000 ms (the fixture's `clientTimeoutMs`), a proxy may
reasonably pass less, and a test bounds the elapsed time against a stub that
never answers.

### Security notes

- **The token is never parsed, decoded, logged or inspected**, and nothing in
  this package logs at all. It is URL-encoded into a form body — never a URL,
  where an access log would keep it. Errors are swallowed at the boundary
  rather than wrapped, because a wrapped fetch error carries the URL.
- **Redirects are not followed** (`redirect: "manual"`), so a `Location` header
  cannot carry `X-Introspection-Secret` to another host.
- **One call, a 1 s timeout, zero retries, no cache.** A retry against a center
  that is down doubles the latency of every failing request and changes nothing.
- **`503` never leaks upstream detail**, including the center's own `401` about
  *our* caller secret — relaying that would tell an operator to sign in again,
  forever, against a service that cannot accept them. A partial or wrongly
  typed answer is `503` rather than `active: false`, so a half-deployed center
  does not become a fleet-wide `401` storm, and the body is read under a 64 KiB
  cap.
- **A malformed `Authorization` header is never repaired.** `"Bearer"`,
  `"Bearer "`, `"Bearer abc def"` and two `Authorization` headers (Express joins
  them into `"Bearer a, Bearer b"`) all read as *no credential*.
- **A guard that cannot do its job fails closed.** An injected introspector that
  rejects or throws calls `next(error)` — never bare `next()`, which would run
  the handler the guard just failed to authorize.

## Development

```sh
npm ci && npm run typecheck && npm run build && npm test
```

CI additionally packs the tarball, installs it into a scratch project and
typechecks two probes with `skipLibCheck: false` — one without
`@types/express` (the core claim), one with a real Express app (the adapter
claim) — then proves the registration rules against the **packed** tarball at
runtime, because a typecheck cannot see them.

**Re-vendoring the fixture.** `meta` owns it and this repository holds a copy so
drift shows in a diff, so change `meta` first; the exact commands and the
current provenance live in [`test/fixtures/SOURCE`](test/fixtures/SOURCE).
`meta` runs [`scripts/validate-fixtures.mjs`][validate] on every PR, and the
suite here recomputes the hash, asserts the sorted case names and **fails on an
unknown assertion key**, so a case added upstream is a red test rather than one
quietly skipped.

**Releasing.** Green on `main`, bump `version`, merge, push a matching tag
(`git tag v1.0.0 && git push origin v1.0.0`). The release workflow refuses a
tag that disagrees with `package.json`, then builds, tests, packs and attaches
the `.tgz` to a GitHub Release; `contents: write` lives on that one job.

## Licence

MIT — see [LICENSE](LICENSE). Chosen here because this package is installed
from a public URL by builds outside its own repository.

[d21]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/docs/design/auth-design.md#21-one-verifier-every-service-asks-auth-service-what-a-token-carries
[fixture]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/fixtures/introspection.json
[validate]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/scripts/validate-fixtures.mjs
