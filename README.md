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
`meta` repository — twenty-four conditions for a calling service and nine more
for st-gateway's queue lane, each with the center's response and the exact
status, message, identity and call count expected. That file is vendored into
`test/fixtures/` and the conformance suite drives all thirty-three of its cases
against a real local HTTP stub.

Zero runtime dependencies. CommonJS plus `.d.ts`. Node >= 18.

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

The identity is published on `res.locals` — `res.locals.identity`,
`res.locals.actor`, `res.locals.kind` — with `identityOf(res)`, `actorOf(res)`,
`kindOf(res)` and `hasScope(res, scope)` as typed readers. A knob-class fence
is `kindOf(res) === "machine"`, never a look at the subject prefix and never a
check for the presence of a header, because after decision 21 every caller
presents one.

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
| Non-`GET` route declaring `"none"` | `500` `this route declares no required scope` | **no** |
| No `Authorization`, `GET` declaring `"none"` | proceeds as a visitor, identity `null` | **no** |
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

Then update the commit, date, byte count and sha256 in
[`test/fixtures/SOURCE`](test/fixtures/SOURCE). The suite recomputes the hash
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
