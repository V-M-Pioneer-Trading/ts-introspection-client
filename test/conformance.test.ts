/**
 * @file All forty-one conditions of meta's introspection fixture.
 *
 * Driven against a real local HTTP stub, one per case, so that what the client
 * sends is asserted on the wire and not against a mock of itself. Nothing here
 * is hand-written policy: every status, message, identity and call count comes
 * out of the vendored file, and an assertion key this suite does not recognise
 * fails the case rather than being skipped.
 */

import { createAuthorizer } from "../src/core";
import { createLaneDeriver } from "../src/gateway";
import {
  DEFAULT_TIMEOUT_MS,
  ENV_SECRET,
  ENV_URL,
  MESSAGES,
  SECRET_HEADER,
} from "../src/messages";
import type { Decision } from "../src/types";
import {
  assertKnownExpectKeys,
  countFetches,
  fixtureSha256,
  fixtureBytes,
  loadFixture,
  recordedBytes,
  recordedSha256,
  type FixtureCase,
} from "./support/fixture";
import {
  assertKnownCenterKeys,
  startStubCenter,
  type CenterSpec,
  type StubCenter,
} from "./support/stubCenter";

const fixture = loadFixture();

/** The caller secret used throughout, standing in for the SSM value. */
const SECRET = "test-introspection-secret-4f2a";
const ENDPOINT_PATH = "/auth/v1/introspect";

describe("the vendored fixture", () => {
  it("is byte-identical to what SOURCE records", () => {
    expect(fixtureBytes().length).toBe(recordedBytes());
    expect(fixtureSha256()).toBe(recordedSha256());
  });

  it("is the copy this package was written against", () => {
    // Belt and braces: if both the copy and SOURCE were edited together, this
    // literal still pins the bytes the implementation was reviewed against.
    expect(fixtureSha256()).toBe(
      "d64baac540906202d6ad633d0d5f23273510109499c4c5b556d18b8bd486c837"
    );
  });

  it("holds exactly the calling-service cases this suite implements", () => {
    expect(fixture.cases.map((c) => c.name).sort()).toEqual([
      "active-machine-kind",
      "active-with-irregular-scope-whitespace",
      "active-with-multi-value-scope",
      "active-with-required-scope",
      "active-with-scope-differing-only-in-case",
      "active-with-scope-that-is-a-prefix-of-required",
      "active-without-required-scope",
      "bearer-with-empty-token",
      "bearer-with-internal-whitespace",
      "center-rejects-our-caller-secret",
      "center-returns-500",
      "center-returns-malformed-json",
      "center-times-out",
      "center-unreachable",
      "head-on-guarded-route-with-no-header",
      "head-on-public-get",
      "inactive-token-on-guarded-route",
      "inactive-token-on-public-get",
      "kind-disagrees-with-sub-prefix",
      "mutating-route-with-no-declared-scope",
      "mutating-route-with-no-declared-scope-and-inactive-token",
      "mutating-route-with-no-declared-scope-and-no-header",
      "no-header-on-guarded-route",
      "non-bearer-scheme-on-guarded-route",
      "operator-on-public-get",
      "options-with-no-declared-scope",
      "session-route-with-inactive-token",
      "session-route-with-no-header",
      "session-route-with-scopeless-token",
      "token-on-public-get-while-center-is-down",
      "visitor-on-public-get",
    ]);
    expect(fixture.cases).toHaveLength(31);
  });

  it("holds exactly the gateway cases this suite implements", () => {
    expect(fixture.gatewayCases.map((c) => c.name).sort()).toEqual([
      "gateway-active-machine",
      "gateway-active-operator",
      "gateway-bearer-with-empty-token",
      "gateway-center-rejects-our-caller-secret",
      "gateway-center-unreachable",
      "gateway-inactive-token",
      "gateway-kind-machine-with-user-subject",
      "gateway-kind-operator-with-machine-subject",
      "gateway-no-header",
      "gateway-non-bearer-scheme",
    ]);
    expect(fixture.gatewayCases).toHaveLength(10);
  });

  it("is fixture version 2, the one that exempts the safe methods", () => {
    // Version 1 declared default-deny on every non-GET method. A copy that
    // fell back to it would silently stop asserting the HEAD and OPTIONS
    // cases, which is the drift this number exists to make visible.
    expect(fixture.version).toBe(2);
  });

  it("pins the names the implementation hard-codes", () => {
    expect(fixture.contract.endpoint.method).toBe("POST");
    expect(fixture.contract.endpoint.path).toBe(ENDPOINT_PATH);
    expect(fixture.contract.endpoint.contentType).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(fixture.contract.endpoint.bodyTemplate).toBe("token=<jwt>");
    expect(fixture.contract.endpoint.secretHeader).toBe(SECRET_HEADER);
    expect(fixture.contract.env.url).toBe(ENV_URL);
    expect(fixture.contract.env.secret).toBe(ENV_SECRET);
    expect(fixture.contract.clientTimeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(fixture.contract.retries).toBe(0);
  });

  it("pins the five sentences byte for byte", () => {
    expect(fixture.contract.messages).toEqual({ ...MESSAGES });
  });
});

/** Runs one case against a freshly started stub, and tears it down. */
const withCase = async (
  testCase: FixtureCase,
  run: (stub: StubCenter) => Promise<void>
): Promise<void> => {
  assertKnownExpectKeys(testCase.name, testCase.expect);
  assertKnownCenterKeys(testCase.name, testCase.center);
  const stub = await startStubCenter(testCase.center as CenterSpec);
  try {
    await run(stub);
  } finally {
    await stub.close();
  }
};

/** Assertions shared by both groups: call count, and what went on the wire. */
const assertCenterTraffic = (
  testCase: FixtureCase,
  stub: StubCenter,
  observedCalls: number,
  token: string | null
): void => {
  const expectedCalls = testCase.expect.centerCalls as number;
  expect(observedCalls).toBe(expectedCalls);

  if (testCase.center.transport === undefined) {
    // A reachable stub counts for itself, so the client-side spy and the
    // server-side log have to agree.
    expect(stub.requests).toHaveLength(expectedCalls);
  }

  for (const request of stub.requests) {
    expect(request.method).toBe("POST");
    expect(request.url).toBe(ENDPOINT_PATH);
    // The URL is used verbatim: no path appended, no query string, and above
    // all no token in it, which is where an access log would find it.
    expect(request.url).not.toContain("?");
    if (token !== null) expect(request.url).not.toContain(token);
    expect(request.contentType).toBe("application/x-www-form-urlencoded");
    expect(request.secretHeader).toBe(SECRET);
    expect(request.body).toBe(`token=${encodeURIComponent(token ?? "")}`);
  }

  const expectedRequest = testCase.expect.centerRequest as
    | Record<string, unknown>
    | undefined;
  if (expectedRequest !== undefined) {
    const sent = stub.requests[0];
    expect(sent).toBeDefined();
    expect(sent?.method).toBe(expectedRequest.method);
    expect(sent?.url).toBe(expectedRequest.path);
    expect(sent?.contentType).toBe(expectedRequest.contentType);
    expect(sent?.body).toBe(expectedRequest.body);
    const headers = expectedRequest.headers as Record<string, string>;
    // The fixture writes the value as a placeholder for whatever
    // AUTH_INTROSPECTION_SECRET holds.
    expect(headers[SECRET_HEADER]).toBe(`<${ENV_SECRET}>`);
    expect(sent?.secretHeader).toBe(SECRET);
  }
};

describe("calling-service cases", () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.name}: ${testCase.why.split(".")[0]}`, async () => {
      await withCase(testCase, async (stub) => {
        const counter = countFetches();
        let decision: Decision;
        let elapsedMs: number;
        try {
          const authorizer = createAuthorizer({ url: stub.url, secret: SECRET });
          const startedAt = Date.now();
          decision = await authorizer.authorize({
            method: testCase.route?.method ?? "GET",
            requires: testCase.route?.requires ?? "none",
            authorization: testCase.request.authorization,
          });
          elapsedMs = Date.now() - startedAt;
        } finally {
          counter.restore();
        }

        const expected = testCase.expect;

        if (expected.outcome === "proceed") {
          if (decision.outcome !== "proceed") {
            throw new Error(
              `expected proceed, got ${decision.status} ${decision.message}`
            );
          }
          expect(decision.identity).toEqual(expected.identity);
        } else {
          if (decision.outcome !== "reject") {
            throw new Error(
              `expected reject, got proceed with ${JSON.stringify(decision.identity)}`
            );
          }
          expect(decision.status).toBe(expected.status);
          expect(decision.message).toBe(expected.message);
          for (const forbidden of (expected.messageMustNotContain ??
            []) as string[]) {
            expect(decision.message).not.toContain(forbidden);
          }
        }

        if (expected.maxElapsedMs !== undefined) {
          expect(elapsedMs).toBeLessThanOrEqual(expected.maxElapsedMs as number);
        }

        const token =
          testCase.request.authorization?.toLowerCase().startsWith("bearer ") === true
            ? testCase.request.authorization.slice("bearer ".length).trim()
            : null;
        assertCenterTraffic(testCase, stub, counter.calls, token);
      });
    });
  }
});

describe("gateway lane cases", () => {
  for (const testCase of fixture.gatewayCases) {
    it(`${testCase.name}: ${testCase.why.split(".")[0]}`, async () => {
      await withCase(testCase, async (stub) => {
        const counter = countFetches();
        let lane: string;
        try {
          const deriver = createLaneDeriver({ url: stub.url, secret: SECRET });
          lane = await deriver.derive(testCase.request.authorization);
        } finally {
          counter.restore();
        }

        // The only verdict this group has. A case that produced a status code
        // would mean the gateway had started rejecting things.
        expect(testCase.expect.outcome).toBe("lane");
        expect(testCase.expect.status).toBeUndefined();
        expect(lane).toBe(testCase.expect.lane);

        const token =
          testCase.request.authorization?.toLowerCase().startsWith("bearer ") === true
            ? testCase.request.authorization.slice("bearer ".length).trim()
            : null;
        assertCenterTraffic(testCase, stub, counter.calls, token);
      });
    });
  }
});
