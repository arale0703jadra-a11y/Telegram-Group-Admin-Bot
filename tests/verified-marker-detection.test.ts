import assert from "node:assert/strict";
import test from "node:test";
import {
  findConfiguredVerifiedMarker,
  normalizeConfiguredVerifiedMarkers,
} from "../src/services/verified-marker-detection.js";

test("detects configured markers in message text and visible profile fields", () => {
  assert.equal(
    findConfiguredVerifiedMarker(
      ["hola #VERIFICADA", "User"],
      ["#verificada", "staff"],
    ),
    "#verificada",
  );
  assert.equal(
    findConfiguredVerifiedMarker(["Jane Verificada", ""], ["verificada"]),
    "verificada",
  );
  assert.equal(
    findConfiguredVerifiedMarker(["@staff_user"], ["staff"]),
    "staff",
  );
});

test("matches singular and plural markers after removing hashtags, punctuation, and emoji", () => {
  assert.equal(
    findConfiguredVerifiedMarker(["✨ #VERIFICADAS ✨"], ["Verificada"]),
    "Verificada",
  );
  assert.equal(
    findConfiguredVerifiedMarker(["#verificada"], ["Verificadas"]),
    "Verificadas",
  );
});

test("does not match a marker embedded inside another word", () => {
  assert.equal(
    findConfiguredVerifiedMarker(["unverified account"], ["verified"]),
    undefined,
  );
});

test("normalizes tag lists and rejects invalid, duplicate, or oversized lists", () => {
  assert.deepEqual(
    normalizeConfiguredVerifiedMarkers("#verificada, staff\nVIP"),
    ["#verificada", "staff", "VIP"],
  );
  assert.equal(normalizeConfiguredVerifiedMarkers("verificada, VERIFICADA"), undefined);
  assert.equal(normalizeConfiguredVerifiedMarkers(" "), undefined);
  assert.equal(normalizeConfiguredVerifiedMarkers("x\n".repeat(21)), undefined);
  assert.equal(normalizeConfiguredVerifiedMarkers("x".repeat(65)), undefined);
});
