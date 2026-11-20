import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Estado sin ID de CERBERO: la protección debe figurar DESACTIVADA y
// SECURITY_EXTRA_BOT_IDS no debe poder sustituir al dato obligatorio.
// El cwd cambia a un temporal para que dotenv no reabra ningún .env.
delete process.env.CERBERO_TELEGRAM_BOT_ID;
process.env.SECURITY_EXTRA_BOT_IDS = "123456789";
process.env.OWNER_ID = "900000081";
process.env.ALEXIITA_TELEGRAM_ID = "900000082";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000083";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-bot-diag-pending-"));
process.chdir(testDataDirectory);
after(async () => {
  process.chdir(originalCwd);
  await rm(testDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

const {
  EXTRA_SERVICE_BOT_IDS,
  allowedServiceBotIds,
  getServiceBotConfigWarnings,
  getServiceBotProtectionDiagnostic,
  pendingServiceBotLabels,
} = await import("../src/config.js");

test("A. con CERBERO pendiente la protección figura DESACTIVADA", () => {
  assert.deepEqual(getServiceBotProtectionDiagnostic(), {
    botProtection: "DESACTIVADA",
    cerbero: "PENDIENTE",
    authorizedBots: 1,
    invalidExtraBotIds: 0,
  });
  assert.deepEqual(pendingServiceBotLabels(), ["CERBERO"]);
  assert.deepEqual(getServiceBotConfigWarnings(), [], "sin entradas inválidas ni colisiones");
});

test("B. SECURITY_EXTRA_BOT_IDS no sustituye al ID obligatorio de CERBERO", () => {
  assert.deepEqual(EXTRA_SERVICE_BOT_IDS, [123456789], "el valor extra sí se analiza");
  assert.deepEqual(allowedServiceBotIds(), [123456789], "y entra en la lista de autorizados");
  assert.deepEqual(
    pendingServiceBotLabels(),
    ["CERBERO"],
    "el pendiente de CERBERO sigue existiendo: la variable extra no lo cubre",
  );
  assert.equal(
    getServiceBotProtectionDiagnostic().botProtection,
    "DESACTIVADA",
    "la expulsión sigue sin armar",
  );
});
