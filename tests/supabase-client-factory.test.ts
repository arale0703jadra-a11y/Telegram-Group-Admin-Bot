import assert from "node:assert/strict";
import test from "node:test";
import {
  getInternalSupabaseClient,
  getRestrictedSupabaseClient,
  resetSupabaseClients,
} from "../src/supabase.js";

/**
 * Fase 7: la fábrica central nunca debe servir un cliente de una configuración
 * anterior. Es la garantía de la que dependen los servicios que dejaron de
 * cachear el cliente por su cuenta.
 */

const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINAL_RESTRICTED_URL = process.env.SUPABASE_RESTRICTED_URL;
const ORIGINAL_RESTRICTED_KEY = process.env.SUPABASE_RESTRICTED_KEY;

function restore(): void {
  if (ORIGINAL_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
  if (ORIGINAL_RESTRICTED_URL === undefined) delete process.env.SUPABASE_RESTRICTED_URL;
  else process.env.SUPABASE_RESTRICTED_URL = ORIGINAL_RESTRICTED_URL;
  if (ORIGINAL_RESTRICTED_KEY === undefined) delete process.env.SUPABASE_RESTRICTED_KEY;
  else process.env.SUPABASE_RESTRICTED_KEY = ORIGINAL_RESTRICTED_KEY;
  resetSupabaseClients();
}

test("the same configuration reuses one client and a new key replaces it", () => {
  try {
    process.env.SUPABASE_URL = "https://zeus-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-a";

    const first = getInternalSupabaseClient();
    assert.equal(getInternalSupabaseClient(), first);

    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-b";
    const second = getInternalSupabaseClient();
    assert.notEqual(second, first, "a rotated key must not reuse the old client");

    process.env.SUPABASE_URL = "https://zeus-other.supabase.co";
    const third = getInternalSupabaseClient();
    assert.notEqual(third, second, "a different project must not reuse the old client");
  } finally {
    restore();
  }
});

test("resetSupabaseClients drops the cached client", () => {
  try {
    process.env.SUPABASE_URL = "https://zeus-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-a";
    const first = getInternalSupabaseClient();
    resetSupabaseClients();
    const afterReset = getInternalSupabaseClient();
    assert.notEqual(afterReset, first);
  } finally {
    restore();
  }
});

test("missing credentials throw instead of reusing a cached client", () => {
  try {
    process.env.SUPABASE_URL = "https://zeus-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-a";
    getInternalSupabaseClient();

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.throws(() => getInternalSupabaseClient(), /SUPABASE_URL/);
  } finally {
    restore();
  }
});

test("the restricted client is absent until it is configured", () => {
  try {
    delete process.env.SUPABASE_RESTRICTED_URL;
    delete process.env.SUPABASE_RESTRICTED_KEY;
    assert.equal(getRestrictedSupabaseClient(), undefined);

    process.env.SUPABASE_RESTRICTED_URL = "https://zeus-test.supabase.co";
    process.env.SUPABASE_RESTRICTED_KEY = "restricted-key";
    const restricted = getRestrictedSupabaseClient();
    assert.notEqual(restricted, undefined);
    assert.equal(getRestrictedSupabaseClient(), restricted);

    delete process.env.SUPABASE_RESTRICTED_KEY;
    assert.equal(getRestrictedSupabaseClient(), undefined);
  } finally {
    restore();
  }
});
