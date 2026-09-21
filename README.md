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
`meta` repository — thirty-one conditions for a calling service and ten more
for st-gateway's queue lane, each with the center's response and the exact
status, message, identity and call count expected. That file is vendored into
`test/fixtures/` and the conformance suite drives all forty-one of its cases
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

### 1. Router-level guard — fleet-service's shape

One `use`, mounted once, with a resolver that maps a request to what its route
declares. **The fallback must be `"none"`**: that is what makes a mutating
route nobody guarded answer `500` instead of running.

```ts
import { actorOf, createExpressAuth } from "@v-m-pioneer-trading/introspection-client";

const auth = createExpressAuth(config);
const table: Record<string, string> = {
  "POST /ships/navigate": "fleet:control",
  "GET /cooldown": "session",
};

router.use(auth.guard((req) => table[`${req.method} ${req.path}`] ?? "none"));
router.post("/ships/navigate", (_req, res) => res.json({ by: actorOf(res) }));
```

### 2. Per-route guards — automation-service's shape

```ts
const auth = createExpressAuth(config);

app.get("/health", auth.allowPublic(), handler);
app.get("/targets", auth.requireSession(), handler);
app.post("/targets", auth.requireScope("fleet:control"), handler);
```

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

**Per-route guards alone cannot give default-deny** — a route with no guard has
nothing to run — so a service using them must *also* mount `auth.guard()`
router-level. This is stated rather than hidden: default-deny is the part of
decision 21 that makes an unguarded `POST` structurally impossible.

### 3. Lane policy — st-gateway's shape

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
returns a `Decision` and touches no framework. The Express adapter is a thin
translation over it; a `mux` wrapper would be another.

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
| A resolver that throws, on any method | `500` `this route declares no required scope` | **no** |
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

## Method handling

**Default-deny applies to mutating methods only.** `GET`, `HEAD` and `OPTIONS`
are the safe methods of RFC 9110 §9.2.1 and are exempt from it (owner's
delegate, 2026-09-21; `meta` fixture `version: 2`). Method names are compared
**case-insensitively**; scope literals are compared **exactly** — not by
prefix, not by namespace walk, not case-folded, so `fleet:control:read` and
`FLEET:CONTROL` both fail a route requiring `fleet:control`.

- **`HEAD` is the same route as `GET`.** Express dispatches `HEAD /x` to the
  `GET /x` handler, so the adapter calls your resolver with `req.method`
  reading `"GET"` for a `HEAD`. A table keyed `"GET /cooldown"` therefore
  governs `HEAD /cooldown` as well, with no second entry. Without that, a
  `HEAD` would miss the table, fall back to `"none"` and serve a guarded
  route's headers — which leak existence, sizes and `ETag`s — to an anonymous
  caller. Exemption from *default-deny* is not exemption from a requirement
  the route *declared*: `HEAD` with no credential on a guarded route is the
  same `401` as `GET`.
- **`OPTIONS` with no declared requirement proceeds as a visitor.** A CORS
  preflight carries no `Authorization` header by definition.
- **The real `req.method` is never mutated.** Only the object handed to the
  resolver reads `"GET"`; your handlers, and the policy itself, still see the
  `HEAD`.

### Mounting cors

Either order works and both are tested, but **mount `cors()` before the
guard**:

```ts
app.use(cors());          // answers the preflight itself, 204
app.use(auth.guard(...)); // never sees it
```

Mounted the other way the preflight reaches the guard first. That is fine —
`OPTIONS` is safe, so it proceeds as a visitor and `cors()` answers — but it
spends a middleware hop on every preflight and depends on the route resolving
to `"none"` for `OPTIONS`. If a resolver ever returns a scope for an `OPTIONS`,
the preflight gets a `401` the browser reports as a CORS failure.

### Method override

**The guard trusts `req.method` and reads no override header.**
`X-HTTP-Method-Override` is ignored, and a test pins that it is: if it were
honoured, a `POST` could present itself as a `GET` and walk straight past
default-deny. If a service does use a method-override middleware, **mount it
before the guard**, so that by the time the guard runs `req.method` is the
method the request will actually be handled as. Mounted after, default-deny is
decided about one method and the route runs as another.

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
> When that PR merges, re-point `SOURCE` at the squash commit on `main`. The
> bytes do not change: only the `meta commit` line moves, and the sha256 must
> come out identical.

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
