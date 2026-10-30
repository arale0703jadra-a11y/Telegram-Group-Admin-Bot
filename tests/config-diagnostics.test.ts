import assert from "node:assert/strict";
import test from "node:test";
import { getIdentityConfigurationDiagnostics } from "../src/config.js";

test("identity diagnostics count distinct valid identities without exposing values", () => {
  assert.deepEqual(
    getIdentityConfigurationDiagnostics(["100", " 200 ", "300"]),
    {
      dotenvImportBeforeEvaluation: true,
      configuredValidDistinctIdentities: 3,
      missingOrInvalidIdentities: 0,
      identitiesAvailableAtEvaluation: true,
    },
  );
});

test("a missing or malformed identity does not invalidate the other identities", () => {
  assert.deepEqual(
    getIdentityConfigurationDiagnostics(["100", undefined, "malformed"]),
    {
      dotenvImportBeforeEvaluation: true,
      configuredValidDistinctIdentities: 1,
      missingOrInvalidIdentities: 2,
      identitiesAvailableAtEvaluation: true,
    },
  );
});

test("duplicate identities are counted once and missing identities remain visible", () => {
  assert.deepEqual(
    getIdentityConfigurationDiagnostics(["100", "100", undefined]),
    {
      dotenvImportBeforeEvaluation: true,
      configuredValidDistinctIdentities: 1,
      missingOrInvalidIdentities: 1,
      identitiesAvailableAtEvaluation: true,
    },
  );
});
