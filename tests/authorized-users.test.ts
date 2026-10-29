import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000033";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

// System Owner de la BD DISTINTO de OWNER_ID: los tres usuarios configurados
// deben conservar el panel (modelo de 3 plazas restaurado).
const mockDbOwnerId = 900000099;
globalThis.fetch = (async () =>
  new Response(JSON.stringify([{ owner_user_id: mockDbOwnerId }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { menuCommand } = await import("../src/commands/menu.js");
const { menuNavigation } = await import("../src/menus/index.js");
const { verifiedCommand } = await import("../src/commands/verified.js");
const { registerGroup } = await import("../src/services/group-registry.js");
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

const OWNER = 900000031;
const ALEXIITA = 900000032;
const BOOTSTRAP = 900000033;
const DB_OWNER = 900000099;
const BOT_ID = 900000030;
const ADMIN_IDS = [OWNER, ALEXIITA, BOOTSTRAP];

function createMenuCtx(options: {
  chatType: "private" | "supergroup";
  chatId: number;
  fromId: number;
  username?: string;
  commandText?: string;
  memberStatus?: ChatMember["status"];
}): {
  ctx: MyContext;
  replies: string[];
  sentDms: number[];
} {
  const commandText = options.commandText ?? "/menu";
  const spaceIndex = commandText.indexOf(" ");
  const commandLength = spaceIndex === -1 ? commandText.length : spaceIndex;
  const message = {
    message_id: 1,
    date: 0,
    text: commandText,
    entities: [{ type: "bot_command", offset: 0, length: commandLength }],
  };
  const replies: string[] = [];
  const sentDms: number[] = [];
  const chat =
    options.chatType === "private"
      ? { id: options.chatId, type: "private" as const }
      : { id: options.chatId, type: "supergroup" as const, title: "Grupo" };
  const from = {
    id: options.fromId,
    is_bot: false,
    first_name: "User",
    username: options.username ?? "user",
  };
  const ctx = {
    update: { update_id: 1, message: { ...message, from, chat } },
    message: { ...message, from, chat },
    chat,
    from,
    me: { id: BOT_ID, is_bot: true, username: "zeus_test", first_name: "ZEUS" },
    session: { user: {}, group: {} },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 100 };
    },
    deleteMessage: async () => true,
    api: {
      sendMessage: async (userId: number) => {
        sentDms.push(userId);
        return { message_id: 200 };
      },
      getChatMember: async (
        _chatId: number | string,
        userId: number,
      ): Promise<ChatMember> =>
        ({
          status:
            userId === options.fromId
              ? (options.memberStatus ?? "member")
              : "member",
          user: { id: userId, is_bot: false, first_name: "User" },
        }) as ChatMember,
    },
  } as unknown as MyContext;
  return { ctx, replies, sentDms };
}

async function runMenu(ctx: MyContext): Promise<void> {
  await menuCommand.middleware()(ctx, async () => undefined);
}

test("los tres usuarios autorizados conservan el panel con un System Owner distinto", async () => {
  resetSecurityCaches();
  registerGroup(-920001, "Grupo Uno");
  for (const fromId of [...ADMIN_IDS, DB_OWNER]) {
    resetSecurityCaches();
    const h = createMenuCtx({
      chatType: "private",
      chatId: fromId,
      fromId,
      memberStatus: "administrator",
    });
    await runMenu(h.ctx);
    assert.ok(
      h.replies.some((r) => r.includes("PANEL DE ADMINISTRACIÓN")),
      `el usuario ${fromId} debe conservar el panel; respuestas: ${h.replies.join(" | ")}`,
    );
  }
});

test("un administrador de grupo sin autorización global no abre el panel", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -920002,
    fromId: 900999999,
    memberStatus: "administrator",
  });
  await runMenu(h.ctx);
  assert.equal(h.sentDms.length, 0, "sin DM con panel");
  assert.ok(!h.replies.some((r) => r.includes("PANEL DE ADMINISTRACIÓN")));
});

test("un usuario autorizado conserva el acceso tras cambiar de nombre de usuario", async () => {
  resetSecurityCaches();
  registerGroup(-920001, "Grupo Uno");
  const before = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    username: "nombre_viejo",
    memberStatus: "administrator",
  });
  await runMenu(before.ctx);
  const after = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    username: "nombre_nuevo",
    memberStatus: "administrator",
  });
  await runMenu(after.ctx);
  assert.ok(before.replies.some((r) => r.includes("PANEL DE ADMINISTRACIÓN")));
  assert.ok(after.replies.some((r) => r.includes("PANEL DE ADMINISTRACIÓN")));
});

test("un usuario externo recibe la guía de recuperación y nunca el panel", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "private",
    chatId: 900999999,
    fromId: 900999999,
  });
  await runMenu(h.ctx);
  const reply = h.replies.join(" | ");
  assert.match(reply, /No autorizado/u);
  assert.match(reply, /\/zeus-recuperar/u, "debe explicar el procedimiento de clave");
  assert.ok(!reply.includes("PANEL DE ADMINISTRACIÓN"));
});

test("acciones administrativas comprueban autorización en cada operación", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "private",
    chatId: 900999999,
    fromId: 900999999,
    commandText: "/verificadas",
  });
  await verifiedCommand.middleware()(h.ctx, async () => undefined);
  assert.ok(h.replies.some((r) => /No autorizado para consultar verificadas/u.test(r)));
});

test("los tres usuarios ejecutan los mismos callbacks del panel", async () => {
  for (const adminId of ADMIN_IDS) {
    resetSecurityCaches();
    const answers: string[] = [];
    const edits: number[] = [];
    const callbackQuery = {
      id: `cb-${adminId}`,
      chat_instance: "chat-instance-test",
      from: { id: adminId, is_bot: false, first_name: "User" },
      data: "menu:sub:filtros",
      message: { message_id: 10 },
    };
    const ctx = {
      update: { update_id: 1, callback_query: callbackQuery },
      callbackQuery,
      chat: { id: adminId, type: "private" },
      from: callbackQuery.from,
      me: { id: BOT_ID, is_bot: true, username: "zeus_test", first_name: "ZEUS" },
      session: {
        user: { selectedGroupId: -920001, selectedGroupTitle: "Grupo Uno" },
        group: {},
      },
      answerCallbackQuery: async (text?: string) => {
        if (text) answers.push(text);
      },
      reply: async () => ({ message_id: 1 }),
      api: {
        editMessageText: async () => {
          edits.push(1);
          return true;
        },
        getChatMember: async (): Promise<ChatMember> =>
          ({
            status: "administrator",
            user: { id: adminId, is_bot: false, first_name: "User" },
            can_restrict_members: true,
            can_delete_messages: true,
          }) as ChatMember,
      },
    } as unknown as MyContext;
    await menuNavigation.middleware()(ctx, async () => undefined);
    assert.ok(
      !answers.some((a) => a.includes("No autorizado")),
      `la cuenta ${adminId} no debe ser denegada: ${answers.join(" | ")}`,
    );
    assert.equal(edits.length, 1, `la cuenta ${adminId} debe renderizar el panel`);
  }
});