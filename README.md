# @v-m-pioneer-trading/introspection-client

The TypeScript half of "one verifier". Every service in this system used to
verify Clerk tokens itself — six hand-ported copies across four languages,
which drifted in error text, in whether an actor was recorded and in which
routes had a guard at all, and which produced two real holes where a route
simply had none. [auth-design decision 21][d21] reverses that: auth-service
becomes the only component that verifies a token, and everyone else asks it
what the token carries and compares the answer against what their own route
declares. This package is that client for the three Node services
(fleet-service, automation-service, st-gateway), and its behaviour is not
described here but *fixed* by [`fixtures/introspection.json`][fixture] in the
`meta` repository — thirty-five conditions for a calling service and ten more
for st-gateway's queue lane, each with the center's response and the exact
status, message, identity and call count expected. That file is vendored into
`test/fixtures/` and the conformance suite drives all forty-five of its cases
against a real local HTTP stub.

Zero runtime dependencies, and **no peer dependencies at all** — not even
Express. The adapter's types are declared locally (see
[Method handling](#method-handling)), so a consumer that never touches Express
typechecks this package with `skipLibCheck: false` and nothing installed.
CommonJS plus `.d.ts`. Node >= 18, asserted at startup rather than hoped for:
`loadIntrospectionConfig()` refuses to start if `globalThis.fetch` is missing,
because the alternative is a `503` on every credentialed request that reads as
an auth outage.

## Install

There is no registry. GitHub Packages demands a token even for public
packages, which breaks a `npm ci` inside `node:22-alpine`, and a git
dependency would need git in the image. Instead a `v*` tag builds, tests and
packs the package and attaches the tarball to a GitHub Release, and consumers
install that URL:

```sh
npm install https://github.com/V-M-Pioneer-Trading/ts-introspection-client/releases/download/v1.0.0/v-m-pioneer-trading-introspection-client-1.0.0.tgz
```

`package-lock.json` records the URL with an integrity hash, so the Docker build
needs no token, no git and no network beyond the registry it already reaches.
`dist/` is never committed; it is built by `prepack`, so a tarball cannot
disagree with the source it was cut from.

## Usage

Configuration comes from two environment variables and is validated at
startup, because a service that starts without them would answer `503` to every
mutation and look like an auth outage instead of a misconfiguration:

```ts
import { loadIntrospectionConfig } from "@v-m-pioneer-trading/introspection-client";

const config = loadIntrospectionConfig(); // throws, naming the missing variable
```

### Declare at the route, and let Express bind it

A route says what it needs where it is registered. Express's own matcher then
binds the declaration to exactly the route it binds the handler to — so a mount
prefix, a trailing slash, a case-variant path, a `:parameter` and a `HEAD`
arriving at its `GET` route all resolve the way the route does, because they
*are* the route.

`secured()` is the half that cannot be forgotten: it refuses, **at
registration time**, to register a handler that carries no declaration. The
process does not start. An undeclared route does not exist, rather than
existing and being noticed the first time somebody asks for it.

```ts
import {
  actorOf,
  createExpressAuth,
  passthrough,
  secured,
} from "@v-m-pioneer-trading/introspection-client";

const auth = createExpressAuth(config);
const api = secured(express.Router());

api.use(passthrough(express.json(), "parses bodies; never answers"));

api.get("/health", auth.allowPublic(), health);
api.get("/targets", auth.requireSession(), listTargets);
api.get("/targets/:id", auth.requireSession(), readTarget);
api.post("/targets", auth.requireScope("fleet:control"), (_req, res) => {
  res.json({ by: actorOf(res) });
});

app.use("/api/automation/v1", api);
```

Leave a declaration off and the service refuses to boot:

```
router.get(/ships/:id) was registered without an authorization declaration.

Every route must say what it needs, at the point it is registered:

    auth.allowPublic()                 — anyone, including an anonymous visitor
    auth.requireSession()              — any verified session
    auth.requireScope("fleet:control") — a session carrying that scope

If this handler is middleware rather than a route — a body parser, CORS, a
logger — wrap it: passthrough(handler, "why it never answers").
```

`secured()` patches the router in place and returns it, so it is still an
`express.Router` in every other respect: mount it, nest it (nest `secured()`
routers inside each other), chain `route()`. `use()` accepts a declaration, a
`guard()`, another secured router, an error handler, or a `passthrough()` —
and nothing else, because from the outside a middleware and a route are the
same shape and only the author knows which one will answer.

**`allowPublic()` is how a route becomes public, and the only way.** A route
nobody declared is not public; it is undeclared, and undeclared fails closed.

### Generated routers — fleet-service's shape

fleet-service's routes come out of tsoa. There is no call site to put a
declaration in, so it keeps a router-level guard:

```ts
const api = express.Router();
api.use(auth.guard((req) => (req.method === "GET" ? "session" : "fleet:control")));
RegisterRoutes(api);
app.use("/api/fleet/v1", api);
```

**That resolver is a function of the method and nothing else, and that is the
point.** A `use`-mounted middleware runs *before* any route layer matches, so
`req.route` is `undefined` there and no honest path key exists: `req.path` is
the path after the mount prefix, it has not been through Express's matcher,
and reconstructing what Express would have matched is the thing this package
stopped trying to do. Key on the method, or declare at the route.

A resolver that returns `undefined`, or throws, means **undeclared**: `500
this route declares no required scope`, on every method including `GET`,
before the `Authorization` header is read. There is no `?? "none"` to write,
and there is deliberately no way to spell "I could not find this route, serve
it anyway".

The resolver is handed `method`, `path`, `baseUrl`, `originalUrl`, `header()`
and — when a route has matched, which for a `use` mount it has not —
`route.path`. `baseUrl` and `originalUrl` are there so a diagnostic can name
the whole path; they are not a route key.

On a `HEAD`, the resolver is called with `method` reading `"GET"`, because
`HEAD /x` is the same route as `GET /x` and Express dispatches it there. The
real `req.method` is never mutated.

### Reading the identity

The identity is published on `res.locals.identity`, and the subject is
duplicated to `res.locals.actor` because automation-service's existing
`detail.actor` recording reads that key by name. **`identityOf(res)`,
`actorOf(res)`, `kindOf(res)` and `hasScope(res, scope)` are the supported
accessors** — read `res.locals` directly and you are relying on key names this
package may change.

**There is deliberately no `res.locals.kind`.** It existed and was removed: a
second copy of the center's answer is a second thing to keep true, and the one
failure this package exists to prevent is a service deriving `kind` for
itself. `kindOf(res)` reads `res.locals.identity`, and that is the whole story.
A knob-class fence is `kindOf(res) === "machine"`, never a look at the subject
prefix and never a check for the presence of a header, because after decision
21 every caller presents one.

**Use `secured()` or `guard()`, not both on the same route.** Each one
authorizes, so a route covered by both asks the center twice for one request.

### Lane policy — st-gateway's shape

A separate export, so nothing adopts it by accident. It never rejects, never
throws and never answers `503`: anything other than an active `operator` is
`background`, including a center that does not answer. A gateway that failed
closed would take the public read surface down with auth-service.

```ts
import { createLaneDeriver } from "@v-m-pioneer-trading/introspection-client";

const deriver = createLaneDeriver(config);
const lane = await deriver.derive(req.header("Authorization")); // "interactive" | "background"
```

### Framework-agnostic core

`createAuthorizer(config).authorize({ method, requires, authorization })`
returns a `Decision` and touches no framework. It is the fixture's forty-five
cases and nothing else. The Express adapter is a translation over it that adds
the one thing a fixture cannot reach — binding a requirement to a route; a
`mux` wrapper would have to add the same.

## Environment

| Variable | Meaning |
|---|---|
| `AUTH_INTROSPECTION_URL` | The **full** endpoint URL, `/auth/v1/introspect` included — `http://localhost:3005/auth/v1/introspect` in production for the host-network services, `http://auth-service:3005/auth/v1/introspect` for st-gateway. POSTed to verbatim: never a base URL, never joined with a suffix. |
| `AUTH_INTROSPECTION_SECRET` | The caller secret, sent as `X-Introspection-Secret`. Never the vault's `AUTH_SERVICE_SHARED_SECRET`. |

Both are required. A missing or blank value, a non-`http(s)` URL, or a URL
carrying a query string all refuse to start, and no message ever contains the
secret.

## Behaviour

Rows are in evaluation order, and the first is first for a reason.

| Situation | Answer | Center called |
|---|---|---|
| **Mutating** route declaring `"none"` | `500` `this route declares no required scope` | **no** |
| An **undeclared** route — a resolver that returned `undefined` or threw — on any method | `500` `this route declares no required scope` | **no** |
| No `Authorization`, **safe** method declaring `"none"` | proceeds as a visitor, identity `null` | **no** |
| `Authorization` that is not `Bearer <something>` | `401` `a bearer token is required` | **no** |
| No `Authorization`, route declaring a session or a scope | `401` `a bearer token is required` | **no** |
| `{"active": false}` | `401` `invalid or expired session`, on **every** method | yes |
| Active, route declares `"session"` | proceeds, even with no scopes at all | yes |
| Active, route's scope missing | `403` `this action requires a scope this session does not carry` — the scope is **not** named | yes |
| Active, route's scope present | proceeds with `{sub, kind, scopes}` | yes |
| Center unreachable, timed out, non-2xx, malformed, or rejecting our secret | `503` `the authentication service could not process this request` | yes |

Every rejection uses the `{"error":{"message":…}}` envelope. `scope` is split
on whitespace **runs** with empties discarded, matching `strings.Fields`,
`/\s+/` and `\s+` in the other implementations. `kind` is the center's answer,
used verbatim and never re-derived from the `sub` prefix — that convention now
lives in exactly one place.

## Security model

Four rules. They are stated flatly because each one was arrived at by getting
it wrong first.

**P1. A route with no declaration is never served — for any method, including
`GET`, `HEAD` and `OPTIONS`.** "Public" is a thing a route says out loud with
`allowPublic()`, never a thing that happens because a lookup missed. A
resolver that returns `undefined` or throws is *undeclared*, which is `500
this route declares no required scope`, decided before the `Authorization`
header is read and without calling the center. There is no fallback to
`"none"` anywhere in this package or in this document.

> This is an **adapter** rule about missing declarations, and it is not the
> same thing as the fixture's `requires: "none"`. `"none"` is a route that
> *declared* no credential is needed; the core's behaviour for it is unchanged
> and is still exactly the fixture's. "Undeclared" has no representation in
> the fixture at all.

**P2. Route matching is Express's job.** Declarations live at registration, so
Express's own matcher binds a requirement to the same route it binds the
handler to. A prefix-mounted router, a trailing slash, a case-variant path and
a `:parameter` are then not this package's problem, because they never become
a string it has to look up. `secured()` makes the rule unforgettable by
refusing an undeclared registration at **startup** rather than detecting one
per request. A resolver keyed on the **method alone** is still supported for
generated routers — it is path-independent, so there is nothing for it to get
wrong. A resolver keyed on a path is not supported and no longer documented.

**P3. A declared requirement is enforced identically for every method.**
`OPTIONS` and `HEAD` included, and `app.all` handlers included. `HEAD` is
governed by its `GET` route's declaration, which under P2 falls out rather
than being arranged: Express dispatches `HEAD /x` to the `GET /x` route, and
the declaration is a handler on that route. The safe methods are exempt from
**default-deny** — a route that declared `"none"` serves them to a visitor —
and from nothing else. `HEAD` with no credential on a guarded route is the
same `401` as `GET`; `OPTIONS` on a guarded `app.all` route is too, and it has
to be, because that route answers an `OPTIONS` with the real handler.

**P4. CORS preflight works because `cors()` terminates it, not because the
guard waves it through.** All three consumers mount `cors()` as their first
middleware, which answers the preflight before anything else sees it.
**Mount `cors()` before the guard and before the secured router.** Mounted
after, the preflight never reaches it: an Express router answers an `OPTIONS`
that matches a path but no method *itself*, with a `200` and an `Allow`
header and no `Access-Control-Allow-Origin`, so the browser fails the
preflight. A test pins both orders and that failure mode, so the remedy is
known to be the mount order rather than an exemption for `OPTIONS`.

### What this package does **not** protect

A fence whose gaps are unknown is worse than no fence.

- **Anything mounted before the guard or the secured router.** It answers
  without ever reaching them. A body parser is fine there; a route is not.
- **Handlers registered on the app rather than on a secured router**, and
  handlers registered through a reference to the raw router captured before
  `secured()` wrapped it. `secured()` patches one object; it does not follow
  aliases.
- **What a `passthrough()` actually does.** It is the author's word that a
  handler is middleware and will never answer. That is why it takes a written
  reason.
- **A second copy of this package in one process.** `secured()` would not
  recognise the other copy's declarations — which surfaces as a refusal to
  start, not as a hole, but it surfaces.
- **Anything after the guard runs.** This package decides whether a request
  may proceed; it does not check what the handler then does with the identity.
  A knob fence, a tenant check, an ownership check are the handler's.
- **The method, if something upstream rewrote it.** See below.

### Method handling

`GET`, `HEAD` and `OPTIONS` are the safe methods of RFC 9110 §9.2.1 and are
exempt from **default-deny** (owner's delegate, 2026-09-21; `meta` fixture
`version: 2`). Method names are compared **case-insensitively**, and so is the
bearer **scheme**. Scope literals are compared **exactly** — not by prefix, not
by namespace walk, not case-folded — so `fleet:control:read` and
`FLEET:CONTROL` both fail a route requiring `fleet:control`.

**The guard trusts `req.method` and reads no override header.**
`X-HTTP-Method-Override` is ignored, and a test pins that it is: if it were
honoured, a `POST` could present itself as a `GET` and claim a read's
requirement. If a service does use a method-override middleware, **mount it
before the guard**, so that by the time the guard runs `req.method` is the
method the request will actually be handled as. Mounted after, the requirement
is decided about one method and the route runs as another.

## Security notes

- **The token is never parsed, decoded, logged or inspected.** It is an opaque
  string that goes into a form body. It travels in the body and never in a URL,
  where an access log would keep it.
- **The secret is never logged, and never leaves the configured host.**
  Redirects are not followed (`redirect: "manual"`), so a `Location` header
  cannot carry `X-Introspection-Secret` somewhere else; a `3xx` is simply not a
  `2xx` and fails closed.
- **Nothing in this package logs at all**, which is how "absent from every log
  line" is achieved rather than promised. Errors are swallowed at the boundary
  instead of wrapped, because a wrapped fetch error carries the URL.
- **One call, a 1 s timeout, zero retries, no cache.** A retry against a center
  that is down doubles the latency of every failing request and changes
  nothing; a cache is a second verification path with a different answer and
  would make revocation meaningless for its lifetime.
- **Fail closed, and `503` never leaks upstream detail.** A center that answers
  `401` about *our* caller secret surfaces as `503`, never as `401` — relaying
  it would tell an operator their session expired and send them to sign in
  again, forever, against a service that cannot accept them.
- **A partial or wrongly typed answer is `503`, not `active: false`.** A
  half-deployed center must not become a fleet-wide `401` storm.
- **The response body is read under a 64 KiB cap** and abandoned past it.
- **A malformed `Authorization` header is never repaired.** `"Bearer"`,
  `"Bearer "`, `"Bearer abc def"` and two `Authorization` headers (which
  Express joins into `"Bearer a, Bearer b"`) all read as *no credential*: the
  header must be exactly the scheme plus one token. Joining the remainder
  would invent a credential nobody issued and send it to the center.
- **The token is URL-encoded into the form body**, so `&`, `=`, `+`, `%` and
  CR/LF arrive byte-identical and cannot inject a field or a header.
- **A guard that cannot do its job fails closed.** An injected introspector
  that rejects or throws calls `next(error)` — never bare `next()`, which
  would run the handler the guard just failed to authorize — and a resolver
  that throws answers `500` on **every** method. A resolver that throws has
  told us nothing about the route, and neither `"none"` nor `"session"` is a
  thing to guess in its place.

### Gateway latency, and the `timeoutMs` knob

**`createLaneDeriver` awaits the center.** A *hanging* center therefore adds up
to `timeoutMs` to every **credentialed** request st-gateway proxies — the lane
is still `background` and the request still goes through, but it goes through
late. **Anonymous requests are unaffected**: no credential means nothing to
introspect, so the center is never on the hot path of the public map, and
neither is a `Basic` header or a `"Bearer "` with no token.

`timeoutMs` is configurable on every entry point, including the lane deriver,
and **defaults to 1000 ms** (the fixture's `clientTimeoutMs`). st-gateway may
pass something shorter — it is a proxy, and how much latency an auth outage is
allowed to add to its own hot path is its decision, not this package's:

```ts
const deriver = createLaneDeriver({ ...config, timeoutMs: 250 });
```

A test bounds the elapsed time against a stub that accepts the connection and
never answers, so an unbounded wait is a red test rather than a production
stall.

## Development

```sh
npm ci
npm run typecheck   # ts-jest only checks what a test imports
npm run build
npm test
```

### Re-vendoring the fixture

`meta` owns the fixture; this repository holds a copy so that drift shows up in
a diff. Change `meta` first, then:

```sh
git -C ../meta show HEAD:fixtures/introspection.json > test/fixtures/introspection.json
node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync('test/fixtures/introspection.json');console.log(b.length,c.createHash('sha256').update(b).digest('hex'))"
```

Then update the commit, date, version, byte count and sha256 in
[`test/fixtures/SOURCE`](test/fixtures/SOURCE).

> **The vendored copy currently points at an unmerged pull-request head**
> ([meta#84](https://github.com/V-M-Pioneer-Trading/meta/pull/84), the
> `feat/fixture-safe-methods` branch), because this package implements the
> safe-method rule and cannot honestly point at a commit that predates it.
> It has moved once already, from that branch's first head to its second, when
> the review of this package produced four more fixture cases — a copy that
> leads its original is drift pointing the other way, so `meta` changed first
> and this followed. When the PR merges, re-point `SOURCE` at the squash
> commit on `main`. The bytes do not change then: only the `meta commit` line
> moves, and the sha256 must come out identical.

`meta` also runs [`scripts/validate-fixtures.mjs`][validate] on every PR, which
checks the things a conformance suite structurally cannot check about its own
source of truth — messages that are not `contract.messages` values, a status
paired with the wrong sentence, an identity that disagrees with the center body
it is derived from, an assertion key nobody asserts. Change the fixture there
and that runs before this ever sees it.

The suite recomputes the hash
on every run, asserts the sorted list of case names, and **fails on an unknown
assertion key** — so a case added upstream is a red test rather than a case
quietly skipped. `.gitattributes` marks the copy `-text` so no checkout ever
translates its line endings.

### Releasing

Tests must be green on `main` first. Then bump `version` in `package.json`,
merge, and push a matching tag:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

The release workflow refuses a tag that disagrees with `package.json`, builds,
typechecks, tests, `npm pack`s and attaches the `.tgz` to a GitHub Release.
`contents: write` lives on that one job; the workflow itself is
`contents: read`. Consumers then bump the release URL they install.

## Licence

MIT — see [LICENSE](LICENSE). No other repository in this organisation carries
one; MIT was chosen here because this package is installed from a public URL by
builds outside its own repository.

[d21]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/docs/design/auth-design.md#21-one-verifier-every-service-asks-auth-service-what-a-token-carries
[fixture]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/fixtures/introspection.json
[validate]: https://github.com/V-M-Pioneer-Trading/meta/blob/main/scripts/validate-fixtures.mjs
