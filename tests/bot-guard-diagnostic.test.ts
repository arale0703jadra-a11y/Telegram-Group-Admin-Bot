import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Estado probado: CERBERO configurado + SECURITY_EXTRA_BOT_IDS con entradas
// válidas, duplicadas y malformadas. El entorno se fija ANTES de importar
// config.ts y el cwd cambia a un temporal para que dotenv no abra ningún .env.
process.env.CERBERO_TELEGRAM_BOT_ID = "8884801307";
process.env.SECURITY_EXTRA_BOT_IDS =
  '123456789,123456789,"777",abc,0,-5,99999999999999999999, 888 ';
process.env.OWNER_ID = "900000071";
process.env.ALEXIITA_TELEGRAM_ID = "900000072";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000073";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-bot-diag-"));
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
  CERBERO_BOT_ID,
  EXTRA_SERVICE_BOT_IDS,
  INVALID_EXTRA_BOT_ID_ENTRIES,
  allowedServiceBotIds,
  getServiceBotConfigWarnings,
  getServiceBotProtectionDiagnostic,
  pendingServiceBotLabels,
} = await import("../src/config.js");

/** Forma única permitida de una advertencia de entrada inválida. */
const INVALID_ENTRY_PATTERN =
  /^SECURITY_EXTRA_BOT_IDS: entrada #\d+ descartada \(longitud=\d+, motivo=(formato-no-numérico|entero-fuera-de-rango|valor-no-positivo)\)\. Usa solo IDs numéricos positivos de Telegram separados por comas\.$/u;
/** Forma única permitida del aviso de colisión de identidad. */
const COLLISION_PATTERN =
  /^CERBERO_TELEGRAM_BOT_ID coincide con una identidad administrativa de usuario; .+$/u;

test("A. diagnóstico con CERBERO configurado: protección ACTIVA y recuentos correctos", () => {
  assert.equal(CERBERO_BOT_ID, 8884801307, "el ID aportado se analiza como entero seguro");
  assert.deepEqual(pendingServiceBotLabels(), []);
  // deepEqual sobre el objeto completo: demuestra que el diagnóstico solo
  // contiene estados y recuentos, nunca tokens, credenciales ni IDs sueltos.
  assert.deepEqual(getServiceBotProtectionDiagnostic(), {
    botProtection: "ACTIVA",
    cerbero: "CONFIGURADO",
    authorizedBots: 3,
    invalidExtraBotIds: 5,
  });
});

test("B. las entradas malformadas se detectan sin exponer su valor", () => {
  assert.deepEqual(
    INVALID_EXTRA_BOT_ID_ENTRIES.map(
      (entry) => `${entry.index}:${entry.reason}:${entry.length}`,
    ),
    [
      "3:formato-no-numérico:5",
      "4:formato-no-numérico:3",
      "5:valor-no-positivo:1",
      "6:formato-no-numérico:2",
      "7:entero-fuera-de-rango:20",
    ],
    "posición, motivo y longitud; jamás el valor original",
  );
  assert.deepEqual(
    EXTRA_SERVICE_BOT_IDS,
    [123456789, 888],
    "solo IDs numéricos válidos, deduplicados y en orden",
  );
  assert.deepEqual(allowedServiceBotIds(), [8884801307, 123456789, 888]);

  const warnings = getServiceBotConfigWarnings();
  assert.equal(warnings.length, 5, "una advertencia por entrada inválida");
  for (const warning of warnings) {
    assert.match(warning, INVALID_ENTRY_PATTERN, "formato de aviso controlado");
  }
  const joined = warnings.join("\n");
  for (const leaked of ['777', "abc", "99999999999999999999", "-5", "sb_publishable"]) {
    assert.ok(!joined.includes(leaked), `la advertencia no expone: ${leaked}`);
  }
});

test("D. aviso de identidad solo si el ID de CERBERO coincide con un usuario", () => {
  const correct = getServiceBotConfigWarnings(8884801307);
  assert.equal(
    correct.filter((warning) => warning.startsWith("CERBERO_TELEGRAM_BOT_ID")).length,
    0,
    "con el ID correcto no hay aviso de colisión",
  );
  // OWNER_ID configurado arriba: pegar el ID de una cuenta personal debe avisarse.
  const collision = getServiceBotConfigWarnings(900000071);
  assert.ok(
    collision.some((warning) => COLLISION_PATTERN.test(warning)),
    "se detecta un ID de usuario pegado por error en CERBERO_TELEGRAM_BOT_ID",
  );
  for (const warning of [...correct, ...collision]) {
    assert.ok(
      INVALID_ENTRY_PATTERN.test(warning) || COLLISION_PATTERN.test(warning),
      `aviso con forma desconocida (posible fuga de datos): ${warning}`,
    );
  }
});
