# Changelog

## 1.1.0 — unreleased

Additive. Part of V-M-Pioneer-Trading/meta#80 (step 5).

- `auth.ignoreCredentials()`: a declaration for routes that never read
  identity (health, API docs, static files). The `Authorization` header is
  not read and the center is never called; `identityOf(res)` is `null` and
  `requirementOf(res)` is `"ignore-credentials"`. Accepted on `get`, `head`,
  `options` and `use()` mounts only; refused at registration on any other
  method, and a mutating request reaching it through a mount is `500`.
- `CREDENTIALS_IGNORED` constant and `DeclaredRequirement` type exported.
- `"ignore-credentials"` is reserved: `requireScope()` and a fixed `guard()`
  refuse it, and a `guard()` resolver returning it is undeclared (`500`).
- `allowPublic()`, `authorize()` and the fixture are unchanged.

## 1.0.0 — 2026-09-23

- First release: default-deny `createAuthorizer`, the Express 4 adapter
  (`secured`, `requireScope`, `requireSession`, `allowPublic`, `guard`,
  `passthrough`, `notFound`, accessors), st-gateway's `createLaneDeriver`,
  conformance with `meta/fixtures/introspection.json`.
