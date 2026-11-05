import assert from "node:assert/strict";
import test from "node:test";
import { isPastInactivityThreshold } from "../src/services/inactivity.js";

const day = 24 * 60 * 60;
const now = 2_000_000_000;

test("inactivity threshold is strict: exactly 21 days is not inactive", () => {
  assert.equal(isPastInactivityThreshold(now - 21 * day, 21, now), false);
  assert.equal(isPastInactivityThreshold(now - 21 * day - 1, 21, now), true);
});

test("invalid timestamps and thresholds never qualify for cleanup", () => {
  assert.equal(isPastInactivityThreshold(Number.NaN, 21, now), false);
  assert.equal(isPastInactivityThreshold(0, 21, now), false);
  assert.equal(isPastInactivityThreshold(now + 1, 21, now), false);
  assert.equal(isPastInactivityThreshold(now - 30 * day, 0, now), false);
  assert.equal(isPastInactivityThreshold(now - 30 * day, Number.NaN, now), false);
});
