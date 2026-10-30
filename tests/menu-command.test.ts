import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Composer, InlineKeyboard } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-menu-tests-"));
process.chdir(testDataDirectory);
after(async () => {
  process.chdir(originalCwd);
  await rm(testDataDirectory, { recursive: true, force: true });
});

process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

let simulatedSystemOwnerId = 900000031;

// Supabase simulado: getSystemOwnerId resuelve al owner configurado, sin red.
globalThis.fetch = (async () =>
  new Response(JSON.stringify([{ owner_user_id: simulatedSystemOwnerId }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { menuCommand } = await import("../src/commands/menu.js");
const { startCommand } = await import("../src/commands/start.js");
const { registerCommands } = await import("../src/commands/index.js");
const { registerGroup } = await import("../src/services/group-registry.js");
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

const OWNER = 900000031;
const BOT_ID = 900000030;

interface Harness {
  ctx: MyContext;
  replies: Array<{ text: string; hasKeyboard: boolean; replyMarkup?: unknown }>;
  sentDms: Array<{ userId: number; text: string }>;
  deleted: number;
  getMeCalls: number;
}

function createMenuCtx(options: {
  chatType: "private" | "group" | "supergroup";
  chatId: number;
  fromId: number;
  commandText?: string;
  memberStatus?: ChatMember["status"];
  replyThrowsFirst?: boolean;
  dmThrows?: boolean;
  dmError?: Error;
  botUsername?: string | null;
  getMeError?: Error;
  getMeUsername?: string;
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
  let getMeCalls = 0;
  const chat =
    options.chatType === "private"
      ? { id: options.chatId, type: "private" as const }
      : options.chatType === "group"
        ? { id: options.chatId, type: "group" as const, title: "Grupo de pruebas" }
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
    me: {
      id: BOT_ID,
      is_bot: true,
      username: options.botUsername === undefined
        ? "zeus_test"
        : options.botUsername ?? undefined,
      first_name: "ZEUS",
    },
    session: { user: {}, group: {} },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      replyCalls += 1;
      if (options.replyThrowsFirst && replyCalls === 1) {
        throw new Error("400: Bad Request: can't parse entities");
      }
      replies.push({
        text,
        hasKeyboard: Boolean(other?.reply_markup),
        replyMarkup: other?.reply_markup,
      });
      return { message_id: 100 + replyCalls };
    },
    deleteMessage: async () => true,
    api: {
      sendMessage: async (userId: number, text: string) => {
        if (options.dmThrows) {
          throw new Error("403: Forbidden: bot was blocked by the user");
        }
        if (options.dmError) {
          throw options.dmError;
        }
        sentDms.push({ userId, text });
        return { message_id: 200 };
      },
      getMe: async () => {
        getMeCalls += 1;
        if (options.getMeError) {
          throw options.getMeError;
        }
        return {
          id: BOT_ID,
          is_bot: true,
          first_name: "ZEUS",
          username: options.getMeUsername,
        };
      },
      getChatMember: async (_chatId: number | string, userId: number): Promise<ChatMember> =>
        ({
          status: userId === options.fromId ? (options.memberStatus ?? "member") : "member",
          user: { id: userId, is_bot: false, first_name: "User" },
        }) as ChatMember,
    },
  } as unknown as MyContext;
  return {
    ctx,
    replies,
    sentDms,
    deleted: 0,
    get getMeCalls() {
      return getMeCalls;
    },
  };
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

test("en privado autoriza ctx.from.id, no ctx.chat.id", async () => {
  resetSecurityCaches();
  registerGroup(-910001, "Grupo Uno");
  const authorizedSender = createMenuCtx({
    chatType: "private",
    chatId: 900000099,
    fromId: OWNER,
    memberStatus: "administrator",
  });
  await runMenu(authorizedSender.ctx);
  assert.ok(authorizedSender.replies.some((reply) =>
    reply.text.includes("PANEL DE ADMINISTRACIÓN")
  ));

  resetSecurityCaches();
  const unauthorizedSender = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: 900999999,
    memberStatus: "administrator",
  });
  await runMenu(unauthorizedSender.ctx);
  assert.ok(unauthorizedSender.replies.some((reply) => /No autorizado/u.test(reply.text)));
  assert.ok(!unauthorizedSender.replies.some((reply) =>
    reply.text.includes("PANEL DE ADMINISTRACIÓN")
  ));
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
  assert.equal(h.replies.length, 1, "debe publicar una sola confirmación breve");
  assert.match(h.replies[0]?.text ?? "", /enviado.*por privado/u);
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

  resetSecurityCaches();
  const unauthorizedGroupUser = createMenuCtx({
    chatType: "supergroup",
    chatId: -910010,
    fromId: 900999999,
    memberStatus: "administrator",
    dmThrows: true,
  });
  await runMenu(unauthorizedGroupUser.ctx);
  assert.equal(unauthorizedGroupUser.sentDms.length, 0);
  assert.equal(unauthorizedGroupUser.replies.length, 0);
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

test("si falla el envío privado, se ofrece el deep link sin atribuir una causa", async () => {
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
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]?.text ?? "", /No pude enviar el panel directamente/u);
  assert.doesNotMatch(h.replies[0]?.text ?? "", /nunca inició|te bloqueó/u);
  assert.ok(h.replies[0]?.replyMarkup instanceof InlineKeyboard);
  const markup = h.replies[0]?.replyMarkup as InlineKeyboard;
  const linkButton = markup.inline_keyboard[0]?.[0];
  assert.ok(linkButton && "url" in linkButton);
  assert.equal(linkButton.text, "Abrir ZEUS");
  assert.equal(linkButton.url, "https://t.me/zeus_test?start=menu");
  assert.equal(h.getMeCalls, 0, "debe reutilizar el username disponible en ctx.me");
});

test("el deep link usa getMe del mismo cliente si ctx.me no contiene username", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910007,
    fromId: OWNER,
    memberStatus: "administrator",
    dmError: new Error("network timeout"),
    botUsername: null,
    getMeUsername: "zeus_test",
  });
  await runMenu(h.ctx);
  assert.equal(h.getMeCalls, 1);
  assert.ok(h.replies[0]?.replyMarkup instanceof InlineKeyboard);
  const markup = h.replies[0]?.replyMarkup as InlineKeyboard;
  const linkButton = markup.inline_keyboard[0]?.[0];
  assert.ok(linkButton && "url" in linkButton);
  assert.equal(linkButton.url, "https://t.me/zeus_test?start=menu");
  assert.doesNotMatch(h.replies[0]?.text ?? "", /nunca inició|bloqueó/u);
});

test("no inventa un enlace si getMe falla", async () => {
  resetSecurityCaches();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const h = createMenuCtx({
      chatType: "supergroup",
      chatId: -910008,
      fromId: OWNER,
      memberStatus: "administrator",
      dmError: new Error("network timeout"),
      botUsername: null,
      getMeError: new Error("Telegram unavailable"),
    });
    await runMenu(h.ctx);
    assert.equal(h.getMeCalls, 1);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0]?.hasKeyboard, false);
    assert.match(h.replies[0]?.text ?? "", /ni obtener un enlace/u);
    assert.ok(errors.some((line) => /nombre del bot/u.test(line)));
  } finally {
    console.error = originalError;
  }
});

test("no genera un deep link si getMe devuelve un username vacío", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910014,
    fromId: OWNER,
    memberStatus: "administrator",
    dmError: new Error("network timeout"),
    botUsername: null,
    getMeUsername: "",
  });
  await runMenu(h.ctx);
  assert.equal(h.getMeCalls, 1);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0]?.hasKeyboard, false);
  assert.match(h.replies[0]?.text ?? "", /ni obtener un enlace/u);
});

test("no genera un deep link si el username del bot es inválido", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910012,
    fromId: OWNER,
    memberStatus: "administrator",
    dmError: new Error("network timeout"),
    botUsername: "invalid-username",
  });
  await runMenu(h.ctx);
  assert.equal(h.sentDms.length, 0);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0]?.hasKeyboard, false);
  assert.match(h.replies[0]?.text ?? "", /ni obtener un enlace/u);
});

test("/start menu abre el panel autorizado sin duplicar la bienvenida", async () => {
  resetSecurityCaches();
  registerGroup(-910009, "Grupo profundo");
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    commandText: "/start menu",
    memberStatus: "administrator",
  });
  await startCommand.middleware()(h.ctx, async () => undefined);
  assert.equal(h.replies.length, 1);
  assert.ok(h.replies[0]?.text.includes("PANEL DE ADMINISTRACIÓN"));
  assert.equal(h.replies[0]?.hasKeyboard, true);
});

test("/start menu conserva la denegación para una identidad no autorizada", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "private",
    chatId: 900999999,
    fromId: 900999999,
    commandText: "/start menu",
  });
  await startCommand.middleware()(h.ctx, async () => undefined);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]?.text ?? "", /No autorizado/u);
  assert.equal(h.sentDms.length, 0);
});

test("/start menu vuelve a denegar el acceso cuando se revoca al propietario persistido", async () => {
  const transferredOwnerId = 900000033;
  simulatedSystemOwnerId = transferredOwnerId;
  try {
    resetSecurityCaches();
    registerGroup(-910016, "Grupo de propietario transferido");
    const authorized = createMenuCtx({
      chatType: "private",
      chatId: transferredOwnerId,
      fromId: transferredOwnerId,
      commandText: "/start menu",
      memberStatus: "administrator",
    });
    await startCommand.middleware()(authorized.ctx, async () => undefined);
    assert.ok(authorized.replies.some((reply) =>
      reply.text.includes("PANEL DE ADMINISTRACIÓN")
    ));

    simulatedSystemOwnerId = OWNER;
    resetSecurityCaches();
    const revoked = createMenuCtx({
      chatType: "private",
      chatId: transferredOwnerId,
      fromId: transferredOwnerId,
      commandText: "/start menu",
      memberStatus: "administrator",
    });
    await startCommand.middleware()(revoked.ctx, async () => undefined);
    assert.ok(revoked.replies.some((reply) => /No autorizado/u.test(reply.text)));
    assert.ok(!revoked.replies.some((reply) =>
      reply.text.includes("PANEL DE ADMINISTRACIÓN")
    ));
  } finally {
    simulatedSystemOwnerId = OWNER;
    resetSecurityCaches();
  }
});

test("/start menu fuera del chat privado no abre el panel a una identidad no autorizada", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "supergroup",
    chatId: -910013,
    fromId: 900999999,
    commandText: "/start menu",
    memberStatus: "administrator",
  });
  await startCommand.middleware()(h.ctx, async () => undefined);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]?.text ?? "", /Soy el bot de administración/u);
  assert.doesNotMatch(h.replies[0]?.text ?? "", /PANEL DE ADMINISTRACIÓN/u);
  assert.equal(h.replies[0]?.hasKeyboard, false);
  assert.equal(h.sentDms.length, 0);
});

test("/start menu desde un grupo no abre el panel", async () => {
  resetSecurityCaches();
  const h = createMenuCtx({
    chatType: "group",
    chatId: -910015,
    fromId: 900999999,
    commandText: "/start menu",
    memberStatus: "administrator",
  });
  await startCommand.middleware()(h.ctx, async () => undefined);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]?.text ?? "", /Soy el bot de administración/u);
  assert.doesNotMatch(h.replies[0]?.text ?? "", /PANEL DE ADMINISTRACIÓN/u);
  assert.equal(h.replies[0]?.hasKeyboard, false);
  assert.equal(h.sentDms.length, 0);
});

test("/start menu no abre grupos donde la identidad autorizada ya no es administradora", async () => {
  resetSecurityCaches();
  registerGroup(-910011, "Grupo sin permisos");
  const h = createMenuCtx({
    chatType: "private",
    chatId: OWNER,
    fromId: OWNER,
    commandText: "/start menu",
    memberStatus: "member",
  });
  await startCommand.middleware()(h.ctx, async () => undefined);
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0]?.text ?? "", /No tienes ningún grupo administrable/u);
  assert.equal(h.replies[0]?.hasKeyboard, false);
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