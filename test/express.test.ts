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
import express, { type Express, type RequestHandler } from "express";
import request from "supertest";

import {
  actorOf,
  createExpressAuth,
  type HandlerLike,
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
    // Declared for GET, and therefore governing HEAD of the same path too.
    "GET /ships": "fleet:control",
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
  app.get("/ships", (_req, res) => {
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

/**
 * A cors-like middleware: sets the CORS headers and answers a preflight
 * itself, which is what `cors()` does. Written inline rather than adding a
 * dependency — what is under test is mount ORDER, not that package.
 */
const corsish = (): RequestHandler => (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};

/** A `ResponseLike` that records what the guard did to it. */
interface FakeResponse {
  locals: Record<string, unknown>;
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): unknown;
}

const fakeResponse = (): FakeResponse => {
  const res: FakeResponse = {
    locals: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return body;
    },
  };
  return res;
};

/** Runs one guard against a hand-made request, and waits for it to settle. */
const runHandler = (
  handler: HandlerLike,
  req: { method: string; path: string; authorization?: string },
  res: FakeResponse
): Promise<{ nexted: boolean; error: unknown }> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (nexted: boolean, error: unknown): void => {
      if (settled) return;
      settled = true;
      resolve({ nexted, error });
    };
    handler(
      {
        method: req.method,
        path: req.path,
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? req.authorization : undefined,
      },
      res,
      (error?: unknown) => finish(true, error)
    );
    // A rejection answers on `res` instead of calling next; give the timers
    // and the microtask queue a turn before concluding nothing happened.
    setTimeout(() => finish(false, undefined), 100);
  });

describe("safe methods (meta fixture v2)", () => {
  it("serves HEAD on a public GET to a visitor", async () => {
    // Express dispatches HEAD /status to the GET /status handler. Treating
    // HEAD as mutating answers 500 here and breaks every health probe.
    const response = await request(fleetApp()).head("/status");
    expect(response.status).toBe(200);
  });

  it("enforces on HEAD what the table declared for GET, via the GET key", async () => {
    // The table has no "HEAD /cooldown" key. A resolver consulted with the
    // literal method finds nothing, falls back to "none", and serves a
    // guarded route's headers to an anonymous caller.
    const denied = await request(fleetApp()).head("/cooldown");
    expect(denied.status).toBe(401);

    const allowed = await request(fleetApp())
      .head("/cooldown")
      .set("Authorization", "Bearer guest.token");
    expect(allowed.status).toBe(200);
  });

  it("enforces a scope on HEAD, through the same GET key", async () => {
    const missing = await request(fleetApp())
      .head("/ships")
      .set("Authorization", "Bearer guest.token");
    expect(missing.status).toBe(403);

    const carried = await request(fleetApp())
      .head("/ships")
      .set("Authorization", "Bearer operator.token");
    expect(carried.status).toBe(200);
  });

  it("401s HEAD on a per-route guard, the same as GET", async () => {
    // Per-route guards carry a fixed requirement, so there is no table key to
    // miss — but the exemption must not leak into them either.
    const response = await request(automationApp()).head("/targets");
    expect(response.status).toBe(401);
  });

  it("serves HEAD /health declared with allowPublic()", async () => {
    const response = await request(automationApp()).head("/health");
    expect(response.status).toBe(200);
  });

  it("lets a preflight through when cors is mounted AFTER the guard", async () => {
    // The guard sees the OPTIONS. It declares "none", so it proceeds as a
    // visitor rather than answering 500, and cors replies 204.
    const app = express();
    app.use(
      auth().guard((req) => (req.method === "POST" ? "fleet:control" : "none"))
    );
    app.use(corsish());
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app)
      .options("/targets")
      .set("Origin", "https://dashboard.example")
      .set("Access-Control-Request-Method", "POST");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("lets a preflight through when cors is mounted BEFORE the guard", async () => {
    // The recommended order: the preflight never reaches the guard at all.
    const app = express();
    app.use(corsish());
    app.use(
      auth().guard((req) => (req.method === "POST" ? "fleet:control" : "none"))
    );
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app)
      .options("/targets")
      .set("Origin", "https://dashboard.example")
      .set("Access-Control-Request-Method", "POST");
    expect(response.status).toBe(204);
  });

  it("still guards the real request that follows the preflight", async () => {
    const app = express();
    app.use(corsish());
    app.use(
      auth().guard((req) => (req.method === "POST" ? "fleet:control" : "none"))
    );
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app).post("/targets");
    expect(response.status).toBe(401);
    expect(response.body.ran).toBeUndefined();
  });

  it("compares the method case-insensitively", async () => {
    // A framework hands the adapter whatever it parsed. `get` must not be a
    // mutation, and `post` must not become a safe method.
    const handler = auth().guard("none");

    for (const [method, expected] of [
      ["get", undefined],
      ["head", undefined],
      ["options", undefined],
      ["GET", undefined],
      ["post", 500],
      ["PoSt", 500],
      ["POST", 500],
    ] as const) {
      const res = fakeResponse();
      await runHandler(handler, { method, path: "/x" }, res);
      expect(res.statusCode).toBe(expected);
    }
  });
});

describe("a guard that cannot do its job fails closed", () => {
  const guardedMutation = {
    method: "POST",
    path: "/targets",
    authorization: "Bearer operator.token",
  };

  it("never runs the handler when the injected introspector rejects", async () => {
    // B2. A host may supply its own transport. If it rejects, the request
    // must not reach the handler: `.catch(() => next())` would run it with no
    // identity and no authorization at all.
    const app = express();
    const failing = createExpressAuth({
      introspect: () => Promise.reject(new Error("transport exploded")),
    });
    app.use(failing.guard("fleet:control"));
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app)
      .post("/targets")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.ran).toBeUndefined();
    expect(response.text).not.toContain('"ran"');
  });

  it("never runs the handler when the injected introspector throws", async () => {
    const app = express();
    const throwing = createExpressAuth({
      introspect: () => {
        throw new Error("transport exploded synchronously");
      },
    });
    app.use(throwing.guard("fleet:control"));
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app)
      .post("/targets")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.ran).toBeUndefined();
  });

  it("passes the error to next() rather than calling next() bare", async () => {
    const handler = createExpressAuth({
      introspect: () => Promise.reject(new Error("transport exploded")),
    }).guard("fleet:control");
    const res = fakeResponse();
    const { nexted, error } = await runHandler(handler, guardedMutation, res);
    expect(nexted).toBe(true);
    // Bare `next()` is the mutant: Express would then run the handler.
    expect(error).toBeInstanceOf(Error);
  });

  it("500s a POST whose resolver throws, without running the handler", async () => {
    // B3. A resolver that throws has told us nothing about this route.
    const app = express();
    app.use(
      auth().guard(() => {
        throw new Error("the route table is broken");
      })
    );
    app.post("/targets", (_req, res) => {
      res.json({ ran: true });
    });

    const response = await request(app)
      .post("/targets")
      .set("Authorization", "Bearer operator.token");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { message: MESSAGES.undeclaredRoute },
    });
    expect(response.body.ran).toBeUndefined();
  });

  it("500s a throwing resolver on EVERY method, safe ones included", async () => {
    // The old fallback was `"none"`, which serves every safe method
    // anonymously the moment the route table throws; a `"session"` fallback
    // would serve them to anyone holding any token at all. Both are guesses
    // about a route nobody could describe. 500 on all of them.
    const handler = auth().guard(() => {
      throw new Error("the route table is broken");
    });

    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "DELETE"]) {
      const res = fakeResponse();
      const { nexted } = await runHandler(handler, { method, path: "/x" }, res);
      expect(nexted).toBe(false);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: { message: MESSAGES.undeclaredRoute } });
    }
  });

  it("500s a throwing resolver even for a caller holding a good token", async () => {
    const handler = auth().guard(() => {
      throw new Error("the route table is broken");
    });
    const res = fakeResponse();
    await runHandler(
      handler,
      { method: "GET", path: "/x", authorization: "Bearer operator.token" },
      res
    );
    expect(res.statusCode).toBe(500);
  });
});

describe("the guard trusts req.method and nothing else", () => {
  it("ignores X-HTTP-Method-Override", async () => {
    // S7. No override is honoured here, and none ever will be: if one were, a
    // POST could present itself as a GET and walk past default-deny. A
    // service that wants overrides mounts that middleware BEFORE the guard,
    // so the guard sees the method the request is actually handled as.
    const app = fleetApp();

    // An undeclared POST stays a POST however it asks to be read.
    const asGet = await request(app)
      .post("/ships/jettison")
      .set("X-HTTP-Method-Override", "GET");
    expect(asGet.status).toBe(500);
    expect(asGet.body).toEqual({ error: { message: MESSAGES.undeclaredRoute } });

    const asHead = await request(app)
      .post("/ships/jettison")
      .set("X-HTTP-Method-Override", "HEAD");
    expect(asHead.status).toBe(500);

    // And a public GET is not turned into a refused POST by the header
    // either: the override is simply not read.
    const stillAGet = await request(app)
      .get("/status")
      .set("X-HTTP-Method-Override", "POST");
    expect(stillAGet.status).toBe(200);
  });
});

describe("there is one source of truth for the identity", () => {
  it("publishes identity and actor, and no separate kind", async () => {
    // S4. `res.locals.kind` existed and was removed: a second copy of the
    // center's answer is a second thing to keep true, and the failure this
    // package exists to prevent is a service deriving `kind` for itself.
    // `kindOf(res)` reads `res.locals.identity`, and that is the whole story.
    const app = express();
    app.use(auth().guard("session"));
    app.get("/whoami", (_req, res) => {
      res.json({
        locals: Object.keys(res.locals).sort(),
        kindOf: kindOf(res),
        actorOf: actorOf(res),
      });
    });

    const response = await request(app)
      .get("/whoami")
      .set("Authorization", "Bearer disagreeing.token");
    expect(response.status).toBe(200);
    expect(response.body.locals).toEqual(["actor", "authRequires", "identity"]);
    // The center said machine for a `user_` subject, and that is what is read.
    expect(response.body.kindOf).toBe("machine");
    expect(response.body.actorOf).toBe("user_operator");
  });
});
