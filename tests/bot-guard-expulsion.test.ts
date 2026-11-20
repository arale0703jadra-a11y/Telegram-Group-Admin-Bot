import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ChatMember, User } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

// La lista blanca se resuelve al importar config.ts, así que el entorno se
// fija ANTES de cualquier import. El ID de CERBERO real sigue pendiente en
// producción; aquí se usa un sustituto exclusivo de pruebas (rango 900…)
// para poder demostrar que un ID configurado nunca se expulsa.
process.env.CERBERO_TELEGRAM_BOT_ID = "900000111";
process.env.SECURITY_EXTRA_BOT_IDS = "900000112";
process.env.OWNER_ID = "900000061";
process.env.ALEXIITA_TELEGRAM_ID = "900000062";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000063";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-bot-guard-"));
process.chdir(testDataDirectory);
after(async () => {
  await flushStorage();
  process.chdir(originalCwd);
  await rm(testDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

const {
  botAdditionGuard,
  evaluateBotAdmission,
  handleIncomingBot,
  resolveBotGuardConfig,
} = await import("../src/filters/bot-addition-guard.js");
const { CERBERO_BOT_ID, allowedServiceBotIds, pendingServiceBotLabels } =
  await import("../src/config.js");
const { flushStorage, getGroupData } = await import("../src/storage/index.js");
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

const ZEUS_ID = 900000101;
/** Sustituto de pruebas del hueco de CERBERO. NO es el ID real de CERBERO. */
const CERBERO_STAND_IN_ID = 900000111;
const AUTHORIZED_EXTRA_ID = 900000112;
const UNAUTHORIZED_ID = 900000113;
const UNAUTHORIZED_SECOND_ID = 900000114;

function botUser(id: number, firstName = "TestBot"): User {
  return { id, is_bot: true, first_name: firstName, username: `bot_${id}` } as User;
}

function humanUser(id: number, firstName = "Miembro"): User {
  return { id, is_bot: false, first_name: firstName } as User;
}

interface Harness {
  context: MyContext;
  /** Banes que terminaron correctamente. */
  banned: number[];
  /** Todos los intentos de ban, incluidos los que fallaron. */
  banAttempts: number[];
  nextCalls: number;
}

function createContext(options: {
  groupId: number;
  adder?: { id: number; is_bot?: boolean; status: ChatMember["status"] };
  canRestrict?: boolean;
  banError?: unknown;
  newMembers?: readonly User[];
}): Harness {
  const adder = options.adder ?? { id: 900000150, status: "member" as const };
  const adderUser: User = {
    id: adder.id,
    is_bot: adder.is_bot ?? false,
    first_name: "QuienAñade",
  } as User;
  const chat = { id: options.groupId, type: "supergroup" as const, title: "Grupo" };
  const message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: adderUser,
    new_chat_members: [...(options.newMembers ?? [])],
  };
  const banned: number[] = [];
  const banAttempts: number[] = [];
  let nextCalls = 0;
  const context = {
    update: { update_id: 1, message },
    msg: message,
    message,
    chat,
    from: adderUser,
    me: { id: ZEUS_ID, is_bot: true, first_name: "ZEUS" },
    api: {
      getChatMember: async (_chatId: number, userId: number): Promise<ChatMember> => {
        if (userId === ZEUS_ID) {
          return {
            status: "administrator",
            user: { id: userId, is_bot: true, first_name: "ZEUS" },
            can_delete_messages: true,
            can_restrict_members: options.canRestrict ?? true,
          } as ChatMember;
        }
        if (userId === adder.id) {
          return {
            status: adder.status,
            user: { id: userId, is_bot: adder.is_bot ?? false, first_name: "QuienAñade" },
            ...(adder.status === "restricted" ? { is_member: true } : {}),
          } as ChatMember;
        }
        return {
          status: "member",
          user: { id: userId, is_bot: false, first_name: "Miembro" },
        } as ChatMember;
      },
      banChatMember: async (_chatId: number, userId: number): Promise<boolean> => {
        banAttempts.push(userId);
        if (options.banError) throw options.banError;
        banned.push(userId);
        return true;
      },
    },
  } as unknown as MyContext;

  return {
    context,
    banned,
    banAttempts,
    get nextCalls() {
      return nextCalls;
    },
    set nextCalls(value: number) {
      nextCalls = value;
    },
  } as Harness;
}

async function runMiddleware(harness: Harness): Promise<void> {
  await botAdditionGuard.middleware()(harness.context, async () => {
    harness.nextCalls += 1;
  });
}

async function botAdditionEvents(groupId: number) {
  const data = await getGroupData(groupId);
  return data.events.filter((event) =>
    (event.detail ?? "").startsWith("BOT_ADDITION:"),
  );
}

// ===== PRUEBAS =====

test("1. bot no autorizado añadido por un miembro normal: se expulsa", async () => {
  resetSecurityCaches();
  const groupId = -930000101;
  const harness = createContext({
    groupId,
    adder: { id: 900000150, status: "member" },
    newMembers: [botUser(UNAUTHORIZED_ID)],
  });

  await runMiddleware(harness);

  assert.equal(harness.nextCalls, 1, "la cadena de middlewares continúa");
  assert.deepEqual(harness.banAttempts, [UNAUTHORIZED_ID]);
  assert.deepEqual(harness.banned, [UNAUTHORIZED_ID]);
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1, "un único evento de auditoría");
  assert.equal(events[0]?.result, "ok");
  assert.equal(events[0]?.targetId, UNAUTHORIZED_ID);
  assert.match(events[0]?.detail ?? "", /bot no autorizado/u);
  assert.match(events[0]?.detail ?? "", /quienLoAñadió=miembro/u);
});

test("2. bot no autorizado añadido por un administrador: también se expulsa", async () => {
  resetSecurityCaches();
  const groupId = -930000102;
  const harness = createContext({
    groupId,
    adder: { id: 900000151, status: "administrator" },
    newMembers: [botUser(UNAUTHORIZED_SECOND_ID)],
  });

  await runMiddleware(harness);

  assert.deepEqual(
    harness.banned,
    [UNAUTHORIZED_SECOND_ID],
    "que quien lo añade sea administrador ya no otorga ninguna excepción",
  );
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1);
  assert.match(
    events[0]?.detail ?? "",
    /quienLoAñadió=administrador/u,
    "el rol de quien lo añadió queda solo como contexto de auditoría",
  );
});

test("3. ZEUS: nunca se expulsa a sí mismo", async () => {
  resetSecurityCaches();
  const groupId = -930000103;
  const direct = createContext({ groupId });
  await handleIncomingBot(direct.context, botUser(ZEUS_ID, "ZEUS"));
  assert.equal(direct.banAttempts.length, 0, "sin llamada a banChatMember");
  assert.equal(resolveBotGuardConfig(direct.context).zeusBotId, ZEUS_ID);
  assert.equal(
    evaluateBotAdmission(ZEUS_ID, resolveBotGuardConfig(direct.context)),
    "protected_self",
  );

  const viaMiddleware = createContext({
    groupId: -930000123,
    newMembers: [botUser(ZEUS_ID, "ZEUS")],
  });
  await runMiddleware(viaMiddleware);
  assert.equal(viaMiddleware.banAttempts.length, 0);

  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1);
  assert.match(events[0]?.detail ?? "", /propio ZEUS/u);
});

test("4. CERBERO: nunca se expulsa — el ID declarado para CERBERO queda protegido", async () => {
  resetSecurityCaches();
  // NOTA: el ID real de CERBERO no se conoce y NO se inventa; en este proceso
  // el hueco `CERBERO_TELEGRAM_BOT_ID` se rellena con un sustituto de pruebas
  // para demostrar que el mecanismo protege el ID declarado como CERBERO.
  assert.equal(CERBERO_BOT_ID, CERBERO_STAND_IN_ID, "la config lee el ID declarado");
  assert.deepEqual(
    pendingServiceBotLabels(),
    [],
    "sin IDs pendientes: la expulsión está activa en este proceso",
  );
  assert.ok(allowedServiceBotIds().includes(CERBERO_STAND_IN_ID));

  const groupId = -930000104;
  const harness = createContext({
    groupId,
    newMembers: [botUser(CERBERO_STAND_IN_ID, "CERBERO")],
  });
  await runMiddleware(harness);

  assert.equal(
    harness.banAttempts.length,
    0,
    "nunca se llama a banChatMember para el ID declarado como CERBERO",
  );
  assert.equal(
    evaluateBotAdmission(CERBERO_STAND_IN_ID, resolveBotGuardConfig(harness.context)),
    "protected_allowlist",
  );
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1);
  assert.match(events[0]?.detail ?? "", /bot de servicio autorizado/u);
});

test("5. bot autorizado en la lista blanca: permitido sin expulsión", async () => {
  resetSecurityCaches();
  const groupId = -930000105;
  const harness = createContext({
    groupId,
    newMembers: [botUser(AUTHORIZED_EXTRA_ID)],
  });

  await runMiddleware(harness);

  assert.equal(harness.banAttempts.length, 0);
  assert.equal(harness.banned.length, 0);
  assert.ok(allowedServiceBotIds().includes(AUTHORIZED_EXTRA_ID));
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "ok");
  assert.match(events[0]?.detail ?? "", /autorizado/u);
});

test("6. sin can_restrict_members: no se simula una expulsión exitosa", async () => {
  resetSecurityCaches();
  const groupId = -930000106;
  const harness = createContext({
    groupId,
    canRestrict: false,
    newMembers: [botUser(UNAUTHORIZED_ID)],
  });

  await runMiddleware(harness);

  assert.equal(harness.banAttempts.length, 0, "banChatMember no se invoca");
  assert.equal(harness.banned.length, 0, "no se simula un ban exitoso");
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "error");
  assert.match(events[0]?.detail ?? "", /no tiene permisos/u);
});

test("7. errores 400, 403 y 429 de Telegram quedan registrados", async () => {
  const scenarios = [
    { code: 400, description: "Bad Request: user not found", groupId: -930000107 },
    { code: 403, description: "Forbidden: bot is not administrator", groupId: -930000108 },
    { code: 429, description: "Too Many Requests: retry after 0", groupId: -930000109 },
  ] as const;

  for (const scenario of scenarios) {
    resetSecurityCaches();
    const harness = createContext({
      groupId: scenario.groupId,
      newMembers: [botUser(UNAUTHORIZED_ID)],
      banError: {
        error_code: scenario.code,
        description: scenario.description,
        ...(scenario.code === 429 ? { parameters: { retry_after: 0 } } : {}),
      },
    });

    await handleIncomingBot(harness.context, botUser(UNAUTHORIZED_ID));

    assert.equal(harness.banned.length, 0, `sin ban exitoso con ${scenario.code}`);
    const events = await botAdditionEvents(scenario.groupId);
    assert.equal(events.length, 1, `evento registrado con ${scenario.code}`);
    assert.equal(events[0]?.result, "error");
    assert.match(
      events[0]?.detail ?? "",
      new RegExp(`telegram_${scenario.code}`, "u"),
      `el código ${scenario.code} se registra clasificado`,
    );
  }
});

test("8. evento repetido: no produce sanciones duplicadas", async () => {
  resetSecurityCaches();
  const groupId = -930000110;
  const first = createContext({
    groupId,
    newMembers: [botUser(UNAUTHORIZED_ID)],
  });
  await runMiddleware(first);
  assert.deepEqual(first.banned, [UNAUTHORIZED_ID]);

  // Telegram reenvía el mismo evento de incorporación.
  const second = createContext({
    groupId,
    newMembers: [botUser(UNAUTHORIZED_ID)],
  });
  await runMiddleware(second);

  assert.equal(
    second.banAttempts.length,
    0,
    "el segundo evento no vuelve a llamar a banChatMember",
  );
  assert.equal(second.banned.length, 0);
  const events = await botAdditionEvents(groupId);
  // Fase 1.2 C: la supresión por cooldown pasa a quedar registrada, por lo que
  // ahora se distingue entre la expulsión y el aviso de supresión. La aserción
  // es más estricta que antes: comprueba ambas por separado.
  const expulsions = events.filter((event) =>
    (event.detail ?? "").includes("expulsión permanente"),
  );
  const suppressed = events.filter((event) =>
    (event.detail ?? "").includes("suprimido por cooldown"),
  );
  assert.equal(expulsions.length, 1, "una sola expulsión registrada");
  assert.equal(
    suppressed.length,
    1,
    "la supresión por cooldown queda registrada una sola vez",
  );
});

test("9. usuario normal (is_bot === false): no es expulsado", async () => {
  resetSecurityCaches();
  const groupId = -930000111;
  const harness = createContext({
    groupId,
    newMembers: [humanUser(900000160, "Ana")],
  });

  await runMiddleware(harness);

  assert.equal(harness.nextCalls, 1, "la cadena continúa para las personas");
  assert.equal(harness.banAttempts.length, 0, "banChatMember jamás se invoca");
  const events = await botAdditionEvents(groupId);
  assert.equal(events.length, 0, "sin eventos BOT_ADDITION para personas");
});

test("10. la supresión por cooldown se registra una sola vez por ventana", async () => {
  resetSecurityCaches();
  const groupId = -930000112;
  const first = createContext({
    groupId,
    newMembers: [botUser(UNAUTHORIZED_ID)],
  });
  await runMiddleware(first);
  assert.deepEqual(first.banned, [UNAUTHORIZED_ID], "la primera expulsión se aplica");

  // Ráfaga de eventos repetidos: ninguno debe volver a intentar la expulsión.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeat = createContext({
      groupId,
      newMembers: [botUser(UNAUTHORIZED_ID)],
    });
    await runMiddleware(repeat);
    assert.equal(
      repeat.banAttempts.length,
      0,
      `evento repetido ${attempt + 2}: sin llamada a banChatMember`,
    );
    assert.equal(repeat.banned.length, 0);
  }

  const events = await botAdditionEvents(groupId);
  const expulsions = events.filter((event) =>
    (event.detail ?? "").includes("expulsión permanente"),
  );
  const suppressed = events.filter((event) =>
    (event.detail ?? "").includes("suprimido por cooldown"),
  );
  assert.equal(expulsions.length, 1, "una única expulsión en todo el flujo");
  assert.equal(
    suppressed.length,
    1,
    "un único aviso por ventana de throttle: no se inundan los registros",
  );
});
