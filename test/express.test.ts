/**
 * @file The Express 4 adapter, in both shapes the consumers use.
 *
 * fleet-service mounts one router-level `use` keyed on the request;
 * automation-service decorates routes individually, reads `res.locals.actor`
 * and fences knobs on `kind === "machine"`. Both are exercised here through
 * supertest against a real stub center.
 */

import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import request from "supertest";

import {
  actorOf,
  createExpressAuth,
  hasScope,
  identityOf,
  kindOf,
} from "../src/express";
import { MESSAGES } from "../src/messages";
import type { RouteRequirement } from "../src/types";

const SECRET = "express-suite-secret";

/** Answers from a small table keyed on the token, like the center would. */
const ANSWERS: Record<string, unknown> = {
  "operator.token": {
    active: true,
    sub: "user_operator",
    scope: "fleet:control universe:refresh",
    exp: 4102444800,
    kind: "operator",
  },
  "machine.token": {
    active: true,
    sub: "mch_machine",
    scope: "fleet:control",
    exp: 4102444800,
    kind: "machine",
  },
  // A `user_` subject the center calls a machine: the fence must follow the
  // center, not the prefix.
  "disagreeing.token": {
    active: true,
    sub: "user_operator",
    scope: "fleet:control",
    exp: 4102444800,
    kind: "machine",
  },
  "guest.token": {
    active: true,
    sub: "user_guest",
    scope: "",
    exp: 4102444800,
    kind: "operator",
  },
  "expired.token": { active: false },
};

let center: Server;
let centerUrl: string;

beforeAll(async () => {
  center = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const token =
        new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token") ??
        "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ANSWERS[token] ?? { active: false }));
    })();
  });
  center.listen(0, "127.0.0.1");
  await once(center, "listening");
  const { port } = center.address() as AddressInfo;
  centerUrl = `http://127.0.0.1:${port}/auth/v1/introspect`;
});

afterAll(async () => {
  center.closeAllConnections();
  center.close();
  await once(center, "close");
});

const auth = () => createExpressAuth({ url: centerUrl, secret: SECRET });

/** fleet-service's shape: one router-level `use`, keyed on the request. */
const fleetApp = (): Express => {
  const app = express();
  // The table is the route declaration, and its fallback is `"none"` — which
  // is what makes an unguarded POST answer 500 instead of running.
  const table: Record<string, RouteRequirement> = {
    "POST /ships/navigate": "fleet:control",
    "GET /cooldown": "session",
  };
  app.use(
    auth().guard((req) => table[`${req.method} ${req.path}`] ?? "none")
  );
  app.get("/status", (_req, res) => {
    res.json({ actor: actorOf(res), identity: identityOf(res) });
  });
  app.get("/cooldown", (_req, res) => {
    res.json({ actor: actorOf(res) });
  });
  app.post("/ships/navigate", (_req, res) => {
    res.json({ actor: actorOf(res), kind: kindOf(res) });
  });
  // Nobody added this one to the table. That is the whole point.
  app.post("/ships/jettison", (_req, res) => {
    res.json({ ranTheHandler: true });
  });
  return app;
};

/** automation-service's shape: per-route guards, an actor, a knob fence. */
const automationApp = (): Express => {
  const app = express();
  const a = auth();
  app.get("/health", a.allowPublic(), (_req, res) => {
    res.json({ actor: actorOf(res) });
  });
  app.get("/targets", a.requireSession(), (_req, res) => {
    res.json({ actor: actorOf(res), scopes: identityOf(res)?.scopes });
  });
  app.post("/targets", a.requireScope("fleet:control"), (_req, res) => {
    res.json({ actor: actorOf(res) });
  });
  app.put("/knobs/alert", a.requireScope("fleet:control"), (_req, res) => {
    // The fence keys on the center's `kind`, never on the subject prefix or on
    // the presence of a header — after decision 21 every caller presents one.
    if (kindOf(res) === "machine") {
      res.status(403).json({ error: { message: MESSAGES.missingScope } });
      return;
    }
    res.json({ actor: actorOf(res), refreshes: hasScope(res, "universe:refresh") });
  });
  return app;
};

describe("router-level guard (fleet-service's shape)", () => {
  it("serves a public GET to a visitor without calling the center", async () => {
    const response = await request(fleetApp()).get("/status");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: null, identity: null });
  });

  it("publishes the identity on a public GET that carries a token", async () => {
    const response = await request(fleetApp())
      .get("/status")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBe(200);
    expect(response.body.identity).toEqual({
      sub: "user_operator",
      kind: "operator",
      scopes: ["fleet:control", "universe:refresh"],
    });
  });

  it("authorizes a declared mutation and hands the handler the identity", async () => {
    const response = await request(fleetApp())
      .post("/ships/navigate")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: "user_operator", kind: "operator" });
  });

  it("refuses an undeclared mutating route with 500, and never runs it", async () => {
    const response = await request(fleetApp())
      .post("/ships/jettison")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { message: MESSAGES.undeclaredRoute },
    });
    expect(response.body.ranTheHandler).toBeUndefined();
  });

  it("answers the same 500 with no credential at all", async () => {
    const response = await request(fleetApp()).post("/ships/jettison");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { message: MESSAGES.undeclaredRoute },
    });
  });

  it("401s a session route with no header", async () => {
    const response = await request(fleetApp()).get("/cooldown");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: MESSAGES.missingToken } });
  });

  it("401s a presented token the center rejects, even on a public GET", async () => {
    const response = await request(fleetApp())
      .get("/status")
      .set("Authorization", "Bearer expired.token");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { message: MESSAGES.invalidSession },
    });
  });
});

describe("per-route guards (automation-service's shape)", () => {
  it("lets a scopeless session through a session route", async () => {
    const response = await request(automationApp())
      .get("/targets")
      .set("Authorization", "Bearer guest.token");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: "user_guest", scopes: [] });
  });

  it("403s a session missing the route's scope without naming it", async () => {
    const response = await request(automationApp())
      .post("/targets")
      .set("Authorization", "Bearer guest.token");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: MESSAGES.missingScope } });
    expect(JSON.stringify(response.body)).not.toContain("fleet:control");
  });

  it("records the actor for a machine caller", async () => {
    const response = await request(automationApp())
      .post("/targets")
      .set("Authorization", "Bearer machine.token");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: "mch_machine" });
  });

  it("fences a knob on the center's kind, not on the subject prefix", async () => {
    const asMachine = await request(automationApp())
      .put("/knobs/alert")
      .set("Authorization", "Bearer disagreeing.token");
    expect(asMachine.status).toBe(403);

    const asOperator = await request(automationApp())
      .put("/knobs/alert")
      .set("Authorization", "Bearer operator.token");
    expect(asOperator.status).toBe(200);
    expect(asOperator.body).toEqual({ actor: "user_operator", refreshes: true });
  });

  it("serves a public GET to a visitor", async () => {
    const response = await request(automationApp()).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: null });
  });
});
