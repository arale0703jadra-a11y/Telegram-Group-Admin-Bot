import assert from "node:assert/strict";
import test from "node:test";
import {
  isTelegramPollingConflict,
  TELEGRAM_POLLING_CONFLICT_HINT,
} from "../src/utils/telegram-conflict.js";

/**
 * Auditoría Fase 3: dos instancias del mismo bot con el mismo token se detectan
 * por el 409 de `getUpdates`. El analizador debe ser estricto: un falso positivo
 * haría creer que hay un duplicado cuando el fallo es otro.
 */

test("reconoce el mensaje real de grammY para getUpdates duplicado", () => {
  const message =
    "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; " +
    "make sure that the bot is not running elsewhere)";
  assert.equal(isTelegramPollingConflict(message), true);
});

test("reconoce el 409 aunque el orden del texto cambie", () => {
  assert.equal(
    isTelegramPollingConflict("getUpdates failed with status 409"),
    true,
  );
  assert.equal(
    isTelegramPollingConflict("409: Conflict while polling"),
    true,
  );
});

test("no confunde errores ajenos con un duplicado", () => {
  for (const message of [
    "",
    "ETIMEDOUT",
    "fetch failed",
    "400: Bad Request: message to delete not found",
    "could not serialize access due to concurrent update (40001)",
    "conflict: la fila ya existe",
    "429: Too Many Requests: retry after 30",
  ]) {
    assert.equal(
      isTelegramPollingConflict(message),
      false,
      `falso positivo con: ${message}`,
    );
  }
});

test("la indicación operativa no contiene secretos ni datos de update", () => {
  assert.match(TELEGRAM_POLLING_CONFLICT_HINT, /1 réplica/u);
  assert.match(TELEGRAM_POLLING_CONFLICT_HINT, /RUNBOOK\.md/u);
  assert.doesNotMatch(TELEGRAM_POLLING_CONFLICT_HINT, /\d{6,}:[A-Za-z0-9_-]{20,}/u);
});
