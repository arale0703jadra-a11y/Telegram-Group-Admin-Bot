import assert from "node:assert/strict";
import test from "node:test";

// Variables controladas por el test: no dependen de .env ni de servicios reales.
process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000033";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

const { deliverAdminGuardianAlert, getAdminGuardianAlertRecipients } =
  await import("../src/security/admin-guardian.js");

const OWNER = 900000031;
const ALEXIITA = 900000032;
const BOOTSTRAP = 900000033;

interface SentAlert {
  userId: number;
  text: string;
}

function captureErrors(): { logs: string[]; restore: () => void } {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) => {
    logs.push(values.join(" "));
  };
  return {
    logs,
    restore: () => {
      console.error = original;
    },
  };
}

test("las tres identidades administrativas configuradas reciben la alerta", async () => {
  const recipients = getAdminGuardianAlertRecipients();
  assert.deepEqual(
    [...recipients].sort((a, b) => a - b),
    [OWNER, ALEXIITA, BOOTSTRAP],
  );

  const sent: SentAlert[] = [];
  await deliverAdminGuardianAlert(async (userId, text) => {
    sent.push({ userId, text });
  }, "alerta de prueba");
  assert.deepEqual(
    sent.map((alert) => alert.userId),
    [OWNER, ALEXIITA, BOOTSTRAP],
  );
  assert.ok(sent.every((alert) => alert.text === "alerta de prueba"));
});

test("destinatarios duplicados se notifican una sola vez", async () => {
  const sent: SentAlert[] = [];
  await deliverAdminGuardianAlert(
    async (userId, text) => {
      sent.push({ userId, text });
    },
    "alerta de prueba",
    [OWNER, OWNER, ALEXIITA, ALEXIITA, BOOTSTRAP],
  );
  assert.deepEqual(
    sent.map((alert) => alert.userId),
    [OWNER, ALEXIITA, BOOTSTRAP],
  );
});

test("un fallo de envío en una cuenta no impide notificar al resto", async () => {
  const sent: number[] = [];
  const capture = captureErrors();
  try {
    await deliverAdminGuardianAlert(
      async (userId) => {
        if (userId === OWNER) {
          throw new Error("fallo simulado de Telegram");
        }
        sent.push(userId);
      },
      "alerta de prueba",
      [OWNER, ALEXIITA, BOOTSTRAP],
    );
  } finally {
    capture.restore();
  }
  assert.deepEqual(sent, [ALEXIITA, BOOTSTRAP], "los demás destinatarios se intentan igualmente");
  assert.equal(capture.logs.length, 1, "el fallo se registra una sola vez");
  assert.match(capture.logs[0] ?? "", /ADMIN_GUARDIAN/u);
  assert.ok(
    !capture.logs.join(" ").includes(String(OWNER)),
    "el log no revela el ID del destinatario",
  );
});

test("ID inválidos o ausentes se omiten sin registrar sus valores", async () => {
  const sent: number[] = [];
  const capture = captureErrors();
  try {
    await deliverAdminGuardianAlert(
      async (userId) => {
        sent.push(userId);
      },
      "alerta de prueba",
      [0, -1, 1.5, Number.NaN, -123456, undefined],
    );
  } finally {
    capture.restore();
  }
  assert.deepEqual(sent, [], "ningún ID inválido recibe la alerta");
  assert.equal(capture.logs.length, 1);
  assert.match(capture.logs[0] ?? "", /Sin identidades administrativas/u);
  assert.ok(
    !capture.logs.join(" ").includes("123456"),
    "el log no revela los valores omitidos",
  );
});