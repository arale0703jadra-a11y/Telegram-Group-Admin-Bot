import assert from "node:assert/strict";
import test from "node:test";
import { SessionPersistenceAlerts } from "../src/services/session-persistence-alerts.js";

test("agrupa fallos equivalentes en un solo aviso por incidente", () => {
  const alerts = new SessionPersistenceAlerts();
  const first = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.deepEqual(first, {
    notify: true,
    occurrence: 1,
    notice: "sent",
  });
  for (let i = 2; i <= 5; i += 1) {
    const decision = alerts.recordFailure({
      operation: "read",
      reason: "unavailable",
      databaseCode: "PGRST202",
    });
    assert.equal(decision.notify, false);
    assert.equal(decision.notice, "grouped");
    assert.equal(decision.occurrence, i);
  }
  assert.equal(alerts.snapshot()?.occurrences, 5);
});

test("un error con firma distinta intenta un aviso nuevo respetando el intervalo", () => {
  let clock = 0;
  const alerts = new SessionPersistenceAlerts(() => clock, 60_000);
  const first = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.equal(first.notify, true);

  clock = 1_000;
  const second = alerts.recordFailure({
    operation: "write",
    reason: "conflict",
    databaseCode: "40001",
  });
  assert.equal(second.notify, false);
  assert.equal(second.notice, "rate-limited");

  // Mismo fallo retrasado: se notifica cuando se cumple el intervalo.
  clock = 61_000;
  const delayed = alerts.recordFailure({
    operation: "write",
    reason: "conflict",
    databaseCode: "40001",
  });
  assert.equal(delayed.notify, true);
  assert.equal(delayed.notice, "delayed");
  assert.equal(delayed.occurrence, 2);

  clock = 62_000;
  const grouped = alerts.recordFailure({
    operation: "write",
    reason: "conflict",
    databaseCode: "40001",
  });
  assert.equal(grouped.notify, false);
  assert.equal(grouped.notice, "grouped");
});

test("la recuperación solo se notifica si el incidente llegó a notificarse", () => {
  const alerts = new SessionPersistenceAlerts();
  alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.equal(alerts.recordSuccess(), true);
  assert.equal(alerts.recordSuccess(), false, "una sola vez");
  assert.equal(alerts.snapshot(), undefined);
});

test("un incidente nuevo dentro del cooldown no dispara recuperación si nunca se notificó", () => {
  let clock = 0;
  const alerts = new SessionPersistenceAlerts(() => clock, 60_000);
  const first = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.equal(first.notify, true);
  assert.equal(alerts.recordSuccess(), true, "recuperación del incidente 1");

  // Reincidencia inmediata: el primer aviso queda retenido por frecuencia.
  clock = 1_000;
  const suppressed = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.equal(suppressed.notify, false);
  assert.equal(suppressed.notice, "rate-limited");
  assert.equal(
    alerts.recordSuccess(),
    false,
    "sin aviso previo del incidente no hay recuperación",
  );
});

test("el éxito sin incidente activo es silencioso", () => {
  const alerts = new SessionPersistenceAlerts();
  assert.equal(alerts.recordSuccess(), false);
  assert.equal(alerts.snapshot(), undefined);
});

test("los incidentes se separan por operación, motivo y código", () => {
  const alerts = new SessionPersistenceAlerts();
  alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  const grouped = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST202",
  });
  assert.equal(grouped.notice, "grouped");
  const other = alerts.recordFailure({
    operation: "read",
    reason: "unavailable",
    databaseCode: "PGRST203",
  });
  assert.equal(other.occurrence, 1, "firma distinta = incidente nuevo");
  assert.equal(alerts.snapshot()?.occurrences, 1);
});
