import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { User } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

// Este proceso NO declara ID de CERBERO: reproduce el estado real de
// producción (dato pendiente, no inventado) para comprobar la protección
// fail-safe de la expulsión automática de bots.
delete process.env.CERBERO_TELEGRAM_BOT_ID;
delete process.env.SECURITY_EXTRA_BOT_IDS;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-bot-guard-pending-"));
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

const ZEUS_ID = 900000201;
const UNKNOWN_BOT_ID = 900000209;

function botUser(id: number, firstName = "TestBot"): User {
  return { id, is_bot: true, first_name: firstName, username: `bot_${id}` } as User;
}

interface PendingHarness {
  context: MyContext;
  banAttempts: number[];
  nextCalls: number;
}

function createPendingContext(groupId: number): PendingHarness {
  const adder: User = { id: 900000250, is_bot: false, first_name: "QuienAñade" } as User;
  const chat = { id: groupId, type: "supergroup" as const, title: "Grupo" };
  const message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: adder,
    new_chat_members: [] as User[],
  };
  const banAttempts: number[] = [];
  let nextCalls = 0;
  const context = {
    update: { update_id: 1, message },
    msg: message,
    message,
    chat,
    from: adder,
    me: { id: ZEUS_ID, is_bot: true, first_name: "ZEUS" },
    api: {
      getChatMember: async (_chatId: number, userId: number) => ({
        status: userId === ZEUS_ID ? "administrator" : "member",
        user: { id: userId, is_bot: userId === ZEUS_ID, first_name: "X" },
        ...(userId === ZEUS_ID ? { can_restrict_members: true } : {}),
      }),
      banChatMember: async (_chatId: number, userId: number): Promise<boolean> => {
        banAttempts.push(userId);
        return true;
      },
    },
  } as unknown as MyContext;

  return {
    context,
    banAttempts,
    get nextCalls() {
      return nextCalls;
    },
    set nextCalls(value: number) {
      nextCalls = value;
    },
  } as PendingHarness;
}

test("el ID de CERBERO sigue pendiente: no se inventa ninguno", () => {
  assert.equal(
    CERBERO_BOT_ID,
    undefined,
    "sin fuente local fiable no se configura ningún ID para CERBERO",
  );
  assert.deepEqual(pendingServiceBotLabels(), ["CERBERO"]);
  assert.deepEqual(allowedServiceBotIds(), [], "lista blanca vacía de bots de servicio");
});

test("mientras CERBERO siga pendiente, ZEUS no expulsa a ningún bot", async () => {
  resetSecurityCaches();
  const groupId = -940000101;
  const harness = createPendingContext(groupId);
  const config = resolveBotGuardConfig(harness.context);

  assert.deepEqual(config.pendingServiceBots, ["CERBERO"]);
  assert.equal(
    evaluateBotAdmission(UNKNOWN_BOT_ID, config),
    "blocked_pending_configuration",
    "no se puede distinguir al bot entrante de un CERBERO sin ID",
  );

  await handleIncomingBot(harness.context, botUser(UNKNOWN_BOT_ID));

  assert.equal(
    harness.banAttempts.length,
    0,
    "sin ID de CERBERO no se arriesga ninguna expulsión",
  );
  const data = await getGroupData(groupId);
  const events = data.events.filter((event) =>
    (event.detail ?? "").startsWith("BOT_ADDITION:"),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "rejected");
  assert.match(events[0]?.detail ?? "", /ID numérico pendiente de CERBERO/u);
});

test("el handler de new_chat_members tampoco expulsa bots con configuración pendiente", async () => {
  resetSecurityCaches();
  const groupId = -940000102;
  const harness = createPendingContext(groupId);
  const bot = botUser(UNKNOWN_BOT_ID);
  const message = { ...harness.context.message, new_chat_members: [bot] };
  const context = {
    ...harness.context,
    msg: message,
    message,
    update: { update_id: 1, message },
  } as unknown as MyContext;

  await botAdditionGuard.middleware()(context, async () => {
    harness.nextCalls += 1;
  });

  assert.equal(harness.nextCalls, 1, "la cadena de middlewares continúa");
  assert.equal(harness.banAttempts.length, 0);
});