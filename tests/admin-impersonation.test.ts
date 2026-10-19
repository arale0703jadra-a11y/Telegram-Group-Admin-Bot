import assert from "node:assert/strict";
import test from "node:test";
import { detectAdminImpersonation } from "../src/filters/admin-impersonation.js";

const administrator = {
  id: 10,
  firstName: "Ana",
  lastName: "Martinez",
  username: "ana_martinez",
};

test("matches an exact administrator username, but not the administrator account itself", () => {
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 20, firstName: "Cliente", username: "ana_martinez" },
      [administrator],
    ),
    { kind: "username-exact", adminId: 10 },
  );
  assert.equal(
    detectAdminImpersonation(
      { id: administrator.id, firstName: "Ana", lastName: "Martinez", username: "ana_martinez" },
      [administrator],
    ),
    undefined,
  );
});

test("matches a one-character username lookalike", () => {
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 20, firstName: "Cliente", username: "ana_martine2" },
      [administrator],
    ),
    { kind: "username-near", adminId: 10 },
  );
});

test("matches full administrator names and near matches only with both name parts", () => {
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 20, firstName: "Ana", lastName: "Martinez" },
      [administrator],
    ),
    { kind: "name-exact", adminId: 10 },
  );
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 21, firstName: "Ana", lastName: "Martinezz" },
      [administrator],
    ),
    { kind: "name-near", adminId: 10 },
  );
});

test("normalizes diacritics and Cyrillic homoglyphs", () => {
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 20, firstName: "Аna", lastName: "Martínez" },
      [administrator],
    ),
    { kind: "name-exact", adminId: 10 },
  );
});

test("does not flag a common first name and does match an exact full name", () => {
  assert.equal(
    detectAdminImpersonation(
      { id: 20, firstName: "Ana", lastName: "Garcia", username: "customer_1" },
      [administrator],
    ),
    undefined,
  );
  assert.deepEqual(
    detectAdminImpersonation(
      { id: 21, firstName: "Ana", lastName: "Martin" },
      [{ id: 11, firstName: "Ana", lastName: "Martin" }],
    ),
    { kind: "name-exact", adminId: 11 },
  );
});

test("does not fuzzy-match one-character usernames or one-part display names", () => {
  assert.equal(
    detectAdminImpersonation(
      { id: 20, firstName: "Ana Maria", username: "ana_martin" },
      [administrator],
    ),
    undefined,
  );
  assert.equal(
    detectAdminImpersonation(
      { id: 21, firstName: "Ana" },
      [{ id: 10, firstName: "Ana" }],
    ),
    undefined,
  );
});
