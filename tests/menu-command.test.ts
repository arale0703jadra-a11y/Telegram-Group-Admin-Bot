import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Composer } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

// Supabase simulado: getSystemOwnerId resuelve al owner configurado, sin red.
globalThis.fetch = (async () =>
  new Response(JSON.stringify([{ owner_user_id: 900000031 }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { menuCommand } = await import("../src/commands/menu.js");
const { registerCommands } = await import("../src/commands/index.js");
const { registerGroup } = await import("../src/services/group-registry.js");
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

const OWNER = 900000031;
const BOT_ID = 900000030;

interface Harness {
  ctx: MyContext;
  replies: Array<{ text: string; hasKeyboard: boolean }>;
  sentDms: Array<{ userId: number; text: string }>;
  deleted: number;
}

function createMenuCtx(options: {
  chatType: "private" | "supergroup";
  chatId: number;
  fromId: number;
  commandText?: string;
  memberStatus?: ChatMember["status"];
  replyThrowsFirst?: boolean;
  dmThrows?: boolean;
}): Harness {
  const commandText = options.commandText ?? "/menu";
  const spaceIndex = commandText.indexOf(" ");
  const commandLength = spaceIndex === -1 ? commandText.length : spaceIndex;
  const message = {
    message_id: 1,
    date: 0,
    text: commandText,
    entities: [{ type: "bot_command", offset: 0, length: commandLength }],
  };
  const replies: Harness["replies"] = [];
  const sentDms: Harness["sentDms"] = [];
  let replyCalls = 0;
  const chat =
    options.chatType === "private"
      ? { id: options.chatId, type: "private" as const }
      : { id: options.chatId, type: "supergroup" as const, title: "Grupo de pruebas" };
  const ctx = {
    update: {
      update_id: 1,
      message: {
        ...message,
        from: { id: options.fromId, is_bot: false, first_name: "User" },
        chat,
      },
    },
    message: {
      ...message,
      from: { id: options.fromId, is_bot: false, first_name: "User" },
      chat,
    },
    chat,
    from: { id: options.fromId, is_bot: false, first_name: "User" },
    me: { id: BOT_ID, is_bot: true, username: "zeus_test", first_name: "ZEUS" },
    session: { user: {}, group: {} },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      replyCalls += 1;
      if (options.replyThrowsFirst && replyCalls === 1) {
        throw new Error("400: Bad Request: can't parse entities");
      }
      replies.push({ text, hasKeyboard: Boolean(other?.reply_markup) });
      return { message_id: 100 + replyCalls };
    },
    deleteMessage: async () => true,
    api: {
      sendMessage: async (userId: number, text: string) => {
        if (options.dmThrows) {
          throw new Error("403: Forbidden: bot was blocked by the user");
        }
        sentDms.push({ userId, text });
        return { message_id: 200 };
      },
      getChatMember: async (_chatId: number | string, userId: number): Promise<ChatMember> =>
        ({
          status: userId === options.fromId ? (options.memberStatus ?? "member") : "member",
          user: { id: userId, is_bot: false, first_name: "User" },
        }) as ChatMember,
    },
  } as unknown as MyContext;
  return { ctx, replies, sentDms, deleted: 0 };
}

async function runMenu(ctx: MyContext): Promise<void> {
  await menuCommand.middleware()(ctx, async () => undefined);
}

test("/menu en privado con grupos administrables abre el panel", async () => {
  resetSecurityCaches();
  registerGroup(-910001, "Grupo Uno");
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    memberStatus: "administrator",
  });
  await runMenu(h.ctx);
  assert.ok(
    h.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN") && r.hasKeyboard),
    `respuestas: ${h.replies.map((r) => r.text.slice(0, 40)).join(" | ")}`,
  );
});

test("/menu en privado sin grupos administrables explica cómo empezar", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    memberStatus: "member",
  });
  await runMenu(h.ctx);
  assert.ok(h.replies.some((r) => /No tienes ningún grupo administrable/u.test(r.text)));
  assert.ok(!h.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")));
});

test("/menu en un grupo envía el panel por privado al administrador", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910003,
    fromId: OWNER,
    memberStatus: "administrator",
  });
  await runMenu(h.ctx);
  assert.equal(h.sentDms.length, 1, "el panel debe enviarse por privado");
  assert.equal(h.sentDms[0]?.userId, OWNER);
  assert.ok(h.sentDms[0]?.text.includes("PANEL DE ADMINISTRACIÓN"));
});

test("usuario sin permisos no obtiene el panel administrativo", async () => {
  resetSecurityCaches();
  const privateCtx = createMenuCtx({
    chatType: "private",
    chatId: 900999999,
    fromId: 900999999,
    memberStatus: "administrator",
  });
  await runMenu(privateCtx.ctx);
  assert.ok(privateCtx.replies.some((r) => /No autorizado/u.test(r.text)));
  assert.ok(!privateCtx.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")));
  assert.equal(privateCtx.sentDms.length, 0);

  const nonAdmin = createMenuCtx({
    chatType: "supergroup",
    chatId: -910004,
    fromId: OWNER,
    memberStatus: "member",
  });
  await runMenu(nonAdmin.ctx);
  assert.ok(nonAdmin.replies.some((r) => /solo está disponible para administradores/u.test(r.text)));
  assert.equal(nonAdmin.sentDms.length, 0);
});

test("/menu@zeus_test abre el panel igual que /menu", async () => {
  resetSecurityCaches();
  registerGroup(-910001, "Grupo Uno");
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    commandText: "/menu@zeus_test",
    memberStatus: "administrator",
  });
  await runMenu(h.ctx);
  assert.ok(
    h.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")),
    `respuestas: ${h.replies.map((r) => r.text.slice(0, 40)).join(" | ")}`,
  );
});

test("si el envío privado falla en un grupo, se responde en el grupo con instrucciones", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910006,
    fromId: OWNER,
    memberStatus: "administrator",
    dmThrows: true,
  });
  await runMenu(h.ctx);
  assert.equal(h.sentDms.length, 0);
  assert.ok(
    h.replies.some((r) => /No pude enviarte el panel por privado/u.test(r.text)),
    "el usuario debe recibir una explicación visible en el grupo",
  );
});

test("un error al construir el panel responde con aviso y no se silencia", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    memberStatus: "administrator",
    replyThrowsFirst: true,
  });
  await runMenu(h.ctx);
  assert.ok(
    h.replies.some((r) => /No pude abrir el panel/u.test(r.text)),
    "el fallo debe dejar un aviso visible",
  );
});

test("bot.ts registra los comandos en el arranque real y /menu llega al panel", async () => {
  const source = readFileSync(
    new URL("../src/bot.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /registerCommands\(bot\);/u, "bot.ts debe instalar los comandos");

  resetSecurityCaches();
  registerGroup(-910001, "Grupo Uno");
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    memberStatus: "administrator",
  });
  const composer = new Composer<MyContext>();
  registerCommands(composer);
  await composer.middleware()(h.ctx, async () => undefined);
  assert.ok(
    h.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")),
    "la cadena real de registro debe entregar el panel de /menu",
  );
});