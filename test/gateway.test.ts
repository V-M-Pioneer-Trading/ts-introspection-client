/**
 * @file What the gateway's lane policy COSTS, which the fixture cannot see.
 *
 * The fixture pins every lane. It says nothing about how long a lane takes to
 * pick, and that is the one property st-gateway has to reason about: the
 * policy **awaits** the center, so a center that hangs adds up to `timeoutMs`
 * to every credentialed request it proxies. Anonymous requests never wait,
 * because there is nothing to introspect.
 *
 * These are wall-clock bounds, kept loose enough not to flake on a busy CI box
 * while still failing an unbounded wait by two orders of magnitude.
 */

import { createLaneDeriver } from "../src/gateway";
import { DEFAULT_TIMEOUT_MS } from "../src/messages";
import { startStubCenter } from "./support/stubCenter";

/** A center that accepts the connection and then never answers. */
const startHangingCenter = () => startStubCenter({ delayMs: 60_000, status: 200 });

describe("a hanging center bounds the gateway rather than blocking it", () => {
  it("gives up on a credentialed request inside the configured timeout", async () => {
    const center = await startHangingCenter();
    try {
      const deriver = createLaneDeriver({
        url: center.url,
        secret: "gateway-suite-secret",
        // st-gateway may pass something shorter than the 1 s default; the
        // knob exists precisely so a proxy can decide how much latency an
        // auth outage is allowed to add to its own hot path.
        timeoutMs: 250,
      });

      const startedAt = Date.now();
      const lane = await deriver.derive("Bearer operator.token");
      const elapsedMs = Date.now() - startedAt;

      // Never a rejection, never a throw: a lane, always.
      expect(lane).toBe("background");
      // The bound that matters. A policy that waited on the socket would sit
      // here for the full 60 s.
      expect(elapsedMs).toBeLessThan(2_000);
      // And it did wait for its own budget rather than answering instantly
      // off a cached or guessed result.
      expect(elapsedMs).toBeGreaterThanOrEqual(200);
    } finally {
      await center.close();
    }
  }, 15_000);

  it("does not make an anonymous request wait at all", async () => {
    // No credential means nothing to introspect, so the center is not on the
    // hot path of the public map even while it is hanging.
    const center = await startHangingCenter();
    try {
      const deriver = createLaneDeriver({
        url: center.url,
        secret: "gateway-suite-secret",
        timeoutMs: 250,
      });

      const startedAt = Date.now();
      const lanes = await Promise.all([
        deriver.derive(null),
        deriver.derive(undefined),
        deriver.derive("Basic b3BlcmF0b3I6aHVudGVyMg=="),
        deriver.derive("Bearer "),
      ]);
      const elapsedMs = Date.now() - startedAt;

      expect(lanes).toEqual([
        "background",
        "background",
        "background",
        "background",
      ]);
      expect(elapsedMs).toBeLessThan(100);
      expect(center.requests).toHaveLength(0);
    } finally {
      await center.close();
    }
  }, 15_000);

  it("defaults to the 1 s budget when no timeout is configured", async () => {
    const center = await startHangingCenter();
    try {
      const deriver = createLaneDeriver({
        url: center.url,
        secret: "gateway-suite-secret",
      });

      const startedAt = Date.now();
      const lane = await deriver.derive("Bearer operator.token");
      const elapsedMs = Date.now() - startedAt;

      expect(lane).toBe("background");
      expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_MS - 100);
      expect(elapsedMs).toBeLessThan(DEFAULT_TIMEOUT_MS + 2_000);
    } finally {
      await center.close();
    }
  }, 15_000);
});
