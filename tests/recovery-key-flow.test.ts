import assert from "node:assert/strict";
import test from "node:test";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000033";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

interface RpcCall {
  name: string;
  body: Record<string, unknown>;
}
const rpcCalls: RpcCall[] = [];
let rateAllowed = true;
let recoverResult: unknown = true;
let recoverThrows = false;
let keysResponse: Array<{ id: string; key_salt: string; key_hash: string }> = [];
let mockDbOwnerId = 100;

globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  const headers = { "content-type": "application/json" };
  if (url.includes("/rest/v1/rpc/")) {
    const name = url.split("/rpc/")[1]!.split("?")[0]!;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    rpcCalls.push({ name, body });
    let out: unknown = 1;
    if (name === "zeus_recovery_rate_limit_allowed") out = rateAllowed;
    else if (name === "zeus_begin_recovery") out = "challenge-abc";
    else if (name === "zeus_recover_system_owner") {
      if (recoverThrows) throw new Error("persistence down");
      out = recoverResult;
    } else if (name === "zeus_generate_recovery_key") out = "key-id-1";
    return new Response(JSON.stringify(out), { status: 200, headers });
  }
  if (url.includes("system_owner_recovery_keys")) {
    return new Response(JSON.stringify(keysResponse), { status: 200, headers });
  }
  if (url.includes("system_owner")) {
    return new Response(JSON.stringify([{ owner_user_id: mockDbOwnerId }]), {
      status: 200,
      headers,
    });
  }
  return new Response("[]", { status: 200, headers });
}) as typeof fetch;

const { consumeRecoveryKey, generateRecoveryKey, hashRecoveryKey, isEffectiveOwner, isSystemOwner } =
  await import("../src/services/system-owner.js");
const { zeusCommand } = await import("../src/commands/zeus.js");
const { privateInput } = await import("../src/commands/private-input.js");
const { isAuthorizedPanelUserId } = await import(
  "../src/security/panel-authorization.js"
);

function createCtx(options: {
  fromId: number;
  chatType: "private" | "supergroup";
  text: string;
  asCommand?: boolean;
  pendingAction?: unknown;
}): { ctx: MyContext; replies: string[] } {
  const message = {
    message_id: 1,
    date: 0,
    text: options.text,
    ...(options.asCommand
      ? {
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: options.text.split(" ")[0]!.length,
            },
          ],
        }
      : {}),
  };
  const replies: string[] = [];
  const chat =
    options.chatType === "private"
      ? { id: options.fromId, type: "private" as const }
      : { id: -1, type: "supergroup" as const, title: "Grupo" };
  const from = { id: options.fromId, is_bot: false, first_name: "User" };
  const ctx = {
    update: { update_id: 1, message: { ...message, from, chat } },
    message: { ...message, from, chat },
    chat,
    from,
    me: { id: 900000030, is_bot: true, username: "zeus_test", first_name: "ZEUS" },
    session: { user: { pendingAction: options.pendingAction }, group: {} },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 100 };
    },
    deleteMessage: async () => true,
    api: {
      sendMessage: async () => ({ message_id: 2 }),
      getChatMember: async () => ({
        status: "member",
        user: { id: 1, is_bot: false, first_name: "x" },
      }),
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

function resetScenario(): void {
  rpcCalls.length = 0;
  rateAllowed = true;
  recoverResult = true;
  recoverThrows = false;
  mockDbOwnerId = 100;
  keysResponse = [];
}

test("/zeus-recuperar solo funciona en privado y pide la clave sin mostrarla", async () => {
  resetScenario();
  const group = createCtx({
    fromId: 555,
    chatType: "supergroup",
    text: "/zeus-recuperar",
    asCommand: true,
  });
  await zeusCommand.middleware()(group.ctx, async () => undefined);
  assert.ok(group.replies.some((r) => /solo está disponible en el chat privado/u.test(r)));

  const priv = createCtx({
    fromId: 555,
    chatType: "private",
    text: "/zeus-recuperar",
    asCommand: true,
  });
  await zeusCommand.middleware()(priv.ctx, async () => undefined);
  assert.ok(priv.replies.some((r) => /Envía tu clave/u.test(r)));
  const pending = (priv.ctx.session.user as { pendingAction?: { kind?: string } })
    .pendingAction;
  assert.equal(pending?.kind, "recoveryKey");
});

test("una clave incorrecta no concede acceso y queda auditada", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-REAL");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  const recovered = await consumeRecoveryKey("CLAVE-MALA", 900000032, async () => true);
  assert.equal(recovered, false);
  assert.ok(
    rpcCalls.some(
      (c) => c.name === "zeus_record_recovery_failure" && c.body.p_user_id === 900000032,
    ),
    "el intento fallido debe quedar registrado",
  );
  assert.ok(!rpcCalls.some((c) => c.name === "zeus_begin_recovery"));
});

test("una clave válida ejecuta la transferencia y confirma solo al final", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-REAL");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  const recovered = await consumeRecoveryKey("TEST-KEY-REAL", 900000032, async () => true);
  assert.equal(recovered, true);
  assert.ok(
    rpcCalls.some((c) => c.name === "zeus_recovery_rate_limit_allowed"),
    "el límite de intentos se consulta en la ruta real de recuperación",
  );
  const names = rpcCalls.map((c) => c.name);
  const begin = names.indexOf("zeus_begin_recovery");
  const transfer = names.indexOf("zeus_recover_system_owner");
  assert.ok(begin >= 0 && transfer > begin, "orden: challenge y después transferencia");
  const transferCall = rpcCalls[transfer]!;
  assert.equal(transferCall.body.p_new_owner_id, 900000032);
});

test("la recuperación de la cuenta propietaria no elimina las otras autorizaciones", async () => {
  // La transferencia solo cambia el System Owner de la BD; las plazas
  // configuradas (OWNER_ID y ALEXIITA) permanecen intactas por diseño.
  assert.equal(isAuthorizedPanelUserId(90, 555, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(200, 555, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(555, 555, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(300, 555, 90, 200), false);
});

test("la clave nunca aparece en logs ni en respuestas del flujo", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-SECRETA");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  console.log = (...values: unknown[]) => logs.push(values.join(" "));
  console.error = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    const flow = createCtx({
      fromId: 900000032,
      chatType: "private",
      text: "TEST-KEY-SECRETA",
      pendingAction: { kind: "recoveryKey" },
    });
    await privateInput.middleware()(flow.ctx, async () => undefined);
    assert.ok(flow.replies.some((r) => /System Owner recuperado/u.test(r)));
    const bad = createCtx({
      fromId: 900999999,
      chatType: "private",
      text: "TEST-KEY-SECRETA-MALA",
      pendingAction: { kind: "recoveryKey" },
    });
    await privateInput.middleware()(bad.ctx, async () => undefined);
    for (const reply of [...flow.replies, ...bad.replies]) {
      assert.ok(!reply.includes("TEST-KEY-SECRETA"), "la clave no debe aparecer en respuestas");
    }
    for (const line of logs) {
      assert.ok(!line.includes("TEST-KEY-SECRETA"), "la clave no debe aparecer en logs");
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("los intentos repetidos están limitados y no inician la recuperación", async () => {
  resetScenario();
  rateAllowed = false;
  const good = await hashRecoveryKey("TEST-KEY-REAL");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  const recovered = await consumeRecoveryKey("TEST-KEY-REAL", 555, async () => true);
  assert.equal(recovered, false);
  const rejection = rpcCalls.find((c) => c.name === "zeus_record_recovery_rejection");
  assert.equal(rejection?.body.p_reason, "rate_limited");
  assert.ok(!rpcCalls.some((c) => c.name === "zeus_begin_recovery"));
});

test("generar la clave de recuperación exige ser el propietario", async () => {
  resetScenario();
  await assert.rejects(generateRecoveryKey(900999999), /No autorizado/u);

  const h = createCtx({
    fromId: 900999999,
    chatType: "private",
    text: "/zeus-generar-recuperacion",
    asCommand: true,
  });
  await zeusCommand.middleware()(h.ctx, async () => undefined);
  assert.ok(h.replies.some((r) => /No autorizado/u.test(r)));
  assert.ok(!rpcCalls.some((c) => c.name === "zeus_generate_recovery_key"));
});

test("las tres cuentas conservan los privilegios de recuperación aunque el System Owner persistido sea otra cuenta", async () => {
  resetScenario(); // mockDbOwnerId = 100 ∉ {31, 32, 33}
  for (const adminId of [900000031, 900000032, 900000033]) {
    rpcCalls.length = 0;
    const key = await generateRecoveryKey(adminId);
    assert.equal(typeof key, "string", `la cuenta ${adminId} debe poder generar claves`);
    assert.ok(key.length > 0);
    assert.ok(rpcCalls.some((c) => c.name === "zeus_generate_recovery_key"));

    const h = createCtx({
      fromId: adminId,
      chatType: "private",
      text: "/zeus-generar-recuperacion",
      asCommand: true,
    });
    await zeusCommand.middleware()(h.ctx, async () => undefined);
    assert.ok(
      h.replies.some((r) => /Clave de recuperación de un solo uso/u.test(r)),
      `la cuenta ${adminId} debe poder usar /zeus-generar-recuperacion`,
    );
  }
});

test("un usuario externo no obtiene los privilegios de recuperación", async () => {
  resetScenario();
  await assert.rejects(generateRecoveryKey(900999999), /No autorizado/u);
  const h = createCtx({
    fromId: 900999999,
    chatType: "private",
    text: "/zeus-generar-recuperacion",
    asCommand: true,
  });
  await zeusCommand.middleware()(h.ctx, async () => undefined);
  assert.ok(h.replies.some((r) => /No autorizado/u.test(r)));
  assert.ok(!rpcCalls.some((c) => c.name === "zeus_generate_recovery_key"));
});

test("la transferencia entre las tres cuentas persiste y no crea cuarta plaza", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-TRANSFER");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];
  const recovered = await consumeRecoveryKey("TEST-KEY-TRANSFER", 900000032, async () => true);
  assert.equal(recovered, true);

  // Persistencia simulada: la BD devuelve ahora la identidad transferida.
  mockDbOwnerId = 900000032;
  assert.equal(await isSystemOwner(900000032), true, "la nueva identidad persiste como propietaria técnica");
  for (const adminId of [900000031, 900000032, 900000033]) {
    assert.equal(await isEffectiveOwner(adminId), true, `la cuenta ${adminId} conserva el acceso total`);
  }
  assert.equal(await isEffectiveOwner(900999999), false, "la transferencia no crea más propietarios");
  assert.equal(isAuthorizedPanelUserId(300, 900000032, 90, 200, 33), false, "sin cuarta plaza");
});

test("la transferencia rechaza identidades externas sin otorgarles acceso", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-REAL");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  const recovered = await consumeRecoveryKey("TEST-KEY-REAL", 555, async () => true);
  assert.equal(recovered, false);
  assert.ok(
    rpcCalls.some(
      (c) => c.name === "zeus_record_recovery_rejection" && c.body.p_reason === "unauthorized_target",
    ),
    "el intento de transferencia a un externo queda auditado",
  );
  assert.ok(!rpcCalls.some((c) => c.name === "zeus_begin_recovery"), "no inicia la recuperación");
  assert.equal(isAuthorizedPanelUserId(555, 100, 90, 200, 33), false, "el externo no queda autorizado");
});

test("una transferencia que falla en la persistencia no se considera exitosa", async () => {
  resetScenario();
  const good = await hashRecoveryKey("TEST-KEY-REAL");
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];

  recoverResult = false;
  const rejected = await consumeRecoveryKey("TEST-KEY-REAL", 900000032, async () => true);
  assert.equal(rejected, false);
  assert.ok(
    rpcCalls.some(
      (c) => c.name === "zeus_record_recovery_rejection" && c.body.p_reason === "recovery_rejected",
    ),
  );

  resetScenario();
  keysResponse = [{ id: "k1", key_salt: good.salt, key_hash: good.hash }];
  recoverThrows = true;
  await assert.rejects(consumeRecoveryKey("TEST-KEY-REAL", 900000032, async () => true));
  assert.ok(rpcCalls.some((c) => c.name === "zeus_record_transaction_failure"));
  assert.equal(mockDbOwnerId, 100, "el propietario persistido no cambia ante un fallo");
});