import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuthorizedPanelUser,
  isAuthorizedPanelUserId,
} from "../src/security/panel-authorization.js";

test("panel access recognizes the three authorized identities (owner, configured owner, secondary)", () => {
  assert.equal(isAuthorizedPanelUserId(100, 100, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(200, 100, 90, 200), true);
  // Restaurado: la cuenta configurada en OWNER_ID conserva su plaza aunque
  // el System Owner de la base de datos sea otra cuenta (3 usuarios, no 2).
  assert.equal(isAuthorizedPanelUserId(90, 100, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(300, 100, 90, 200), false);
});

test("configured owner keeps panel access before and after bootstrap", () => {
  assert.equal(isAuthorizedPanelUserId(90, undefined, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(90, 100, 90, 200), true);
});

test("invalid Telegram ids are never authorized", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isAuthorizedPanelUserId(id, 100, 90, 200), false);
  }
});

test("owner lookup failures are logged without exposing details and keep configured identities", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    // Sin identidades configuradas en el entorno de pruebas, un usuario ajeno
    // sigue denegado aunque falle la consulta del propietario.
    assert.equal(
      await isAuthorizedPanelUser(100, async () => {
        throw new Error("sensitive database detail");
      }),
      false,
    );
    // El fallo de la BD nunca amplía el conjunto: solo conserva las plazas
    // configuradas (aquí, OWNER_ID=90 y ALEXIITA=200 vía parámetros).
    assert.equal(isAuthorizedPanelUserId(90, undefined, 90, 200), true);
    assert.equal(isAuthorizedPanelUserId(300, undefined, 90, 200), false);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /"event":"owner_lookup_failed"/);
  assert.match(logs[0] ?? "", /"result":"identity_denied"/);
  assert.doesNotMatch(logs[0] ?? "", /sensitive database detail/);
});

test("la plaza bootstrap configurada tiene la misma autorización de panel", () => {
  assert.equal(isAuthorizedPanelUserId(33, 100, 90, 200, 33), true);
  assert.equal(isAuthorizedPanelUserId(33, 100, 90, 200), false);
});

test("authorization consults the persistent owner source on every call", async () => {
  let calls = 0;
  const lookup = async (): Promise<number | undefined> => {
    calls += 1;
    return 100;
  };
  assert.equal(await isAuthorizedPanelUser(100, lookup), true);
  assert.equal(await isAuthorizedPanelUser(100, lookup), true);
  assert.equal(calls, 2, "sin lista en memoria: la autorización se reevalúa y sobrevive a reinicios");
});

test("authorization logs outcomes and owner presence without identities", async () => {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    assert.equal(await isAuthorizedPanelUser(100, async () => 100), true);
    assert.equal(await isAuthorizedPanelUser(300, async () => undefined), false);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(logs.length, 2);
  assert.match(logs[0] ?? "", /"event":"granted"/);
  assert.match(logs[0] ?? "", /"systemOwnerPersisted":true/);
  assert.match(logs[1] ?? "", /"event":"identity_denied"/);
  assert.match(logs[1] ?? "", /"systemOwnerPersisted":false/);
  assert.doesNotMatch(logs.join(" "), /\b100\b|\b300\b/);
});
