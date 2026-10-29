import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import { promotionModeration } from "../src/filters/moderation.js";
import { detectPromotion } from "../src/filters/detector.js";
import {
  buildPromotionActionPanel,
  buildSubmenuPanel,
} from "../src/menus/panels.js";
import {
  DEFAULT_RECURRENCE_MUTE_MINUTES,
  PROMOTION_DICTIONARY,
  toggleRecurrenceMuteMinutes,
} from "../src/storage/initial.js";
import { flushStorage, getGroupData, saveGroupData } from "../src/storage/index.js";
import { resetSecurityCaches } from "../src/utils/member-cache.js";

const BOT_ID = 900000021;
const USER_ID = 900000022;
const PROMO_TEXT = "Vendo fotos al privado, escríbeme por WhatsApp";

function createCtx(chatId: number, messageId: number, options: { restrictThrows?: boolean } = {}) {
  const deletions: number[] = [];
  const restricts: ChatPermissions[] = [];
  const replies: string[] = [];
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
            can_delete_messages: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Vendedora" },
          } as ChatMember),
    deleteMessage: async (_chatId: number | string, id: number): Promise<boolean> => {
      deletions.push(id);
      return true;
    },
    restrictChatMember: async (
      _chatId: number | string,
      _userId: number,
      permissions: ChatPermissions,
    ): Promise<boolean> => {
      if (options.restrictThrows) throw new Error("403: Forbidden");
      restricts.push(permissions);
      return true;
    },
  };
  const message = { message_id: messageId, text: PROMO_TEXT };
  const ctx = {
    api,
    me: { id: BOT_ID, username: "zeus_test" },
    update: { update_id: 1, message },
    chat: { id: chatId, type: "supergroup", title: "Grupo de pruebas" },
    from: { id: USER_ID, is_bot: false, first_name: "Vendedora" },
    message,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 700 + replies.length };
    },
  } as unknown as MyContext;
  return { ctx, deletions, restricts, replies };
}

async function runFilter(ctx: MyContext): Promise<boolean> {
  let nextCalled = false;
  await promotionModeration.middleware()(ctx, async () => {
    nextCalled = true;
  });
  return nextCalled;
}

function storageFileFor(chatId: number): string {
  return resolve(process.cwd(), "data", "storage", `${chatId}.json`);
}

async function cleanup(chatId: number): Promise<void> {
  resetSecurityCaches();
  await flushStorage();
  const file = storageFileFor(chatId);
  if (existsSync(file)) unlinkSync(file);
}

test("el texto de pruebas se clasifica como venta no verificada", () => {
  const detection = detectPromotion(PROMO_TEXT, PROMOTION_DICTIONARY);
  assert.equal(detection.intent, "SELLING");
  assert.equal(detection.shouldModerate, true);
});

test("el submenú Filtros expone Configurar acción con callback cableado", () => {
  const panel = buildSubmenuPanel("filtros", "Grupo");
  assert.ok(panel);
  const callbacks = panel.keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : ""))
    .filter((value): value is string => Boolean(value));
  assert.ok(callbacks.includes("fa:action"), "falta fa:action");
  assert.ok(!callbacks.some((cb) => cb.startsWith("menu:action:")));
});

test("el panel de acción muestra el escalado y permite alternarlo", () => {
  const base = {
    enabled: true,
    dictionary: [],
    verificationContacts: [],
    verifiedUsers: {},
    recurrenceMuteMinutes: [15, 60, 240, 1440],
    messages: {
      promotionWarning: "",
      promotionRemoved: "",
      promotionMuted: "",
      linkWarning: "",
      verificationRequired: "",
    },
    infractions: {},
    statistics: {
      analyzed: 0,
      buying: 0,
      selling: 0,
      neutral: 0,
      ambiguous: 0,
      blocked: 0,
      allowedVerified: 0,
    },
  };
  const withEscalation = buildPromotionActionPanel(base);
  assert.match(withEscalation.text, /15 min → 60 min → 240 min → 1440 min/u);
  const callbacks = withEscalation.keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : ""));
  assert.ok(callbacks.includes("fa:action_toggle"));
  assert.ok(callbacks.includes("menu:sub:filtros"));

  const withoutEscalation = buildPromotionActionPanel({
    ...base,
    recurrenceMuteMinutes: [],
  });
  assert.match(withoutEscalation.text, /solo se elimina el mensaje/u);
});

test("toggleRecurrenceMuteMinutes alterna entre escalado y solo borrado", () => {
  assert.deepEqual(toggleRecurrenceMuteMinutes([]), DEFAULT_RECURRENCE_MUTE_MINUTES);
  assert.deepEqual(toggleRecurrenceMuteMinutes([15, 60]), []);
});

test("la primera infracción elimina el mensaje sin silenciar", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx, deletions, restricts, replies } = createCtx(chatId, 500);
  try {
    resetSecurityCaches();
    await runFilter(ctx);

    assert.deepEqual(deletions, [500]);
    assert.equal(restricts.length, 0, "la primera infracción no debe silenciar");
    assert.equal(replies.length, 1, "solo se espera la invitación a verificarse");
    const data = await getGroupData(chatId);
    assert.equal(data.promotion.infractions[String(USER_ID)], 1);
    assert.equal(data.promotion.statistics.blocked, 1);
  } finally {
    await cleanup(chatId);
  }
});

test("la segunda infracción aplica el primer escalón de silencio y lo anuncia", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  try {
    resetSecurityCaches();
    const first = createCtx(chatId, 500);
    await runFilter(first.ctx);
    assert.equal(first.restricts.length, 0);

    resetSecurityCaches();
    const second = createCtx(chatId, 501);
    await runFilter(second.ctx);

    assert.deepEqual(second.deletions, [501]);
    assert.equal(second.restricts.length, 1, "la reincidencia debe silenciar");
    assert.equal(second.restricts[0]?.can_send_messages, false);
    const data = await getGroupData(chatId);
    assert.ok(
      second.replies.includes(data.promotion.messages.promotionMuted),
      "el silencio aplicado debe anunciarse",
    );
  } finally {
    await cleanup(chatId);
  }
});

test("con el escalado desactivado la reincidencia no silencia", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  try {
    resetSecurityCaches();
    const data = await getGroupData(chatId);
    data.promotion.recurrenceMuteMinutes = [];
    data.promotion.infractions[String(USER_ID)] = 1;
    await saveGroupData(chatId, data);

    const { ctx, restricts, replies } = createCtx(chatId, 500);
    await runFilter(ctx);

    assert.equal(restricts.length, 0, "sin ladder no hay silencio");
    assert.equal(replies.length, 1, "no debe anunciarse un silencio no aplicado");
  } finally {
    await cleanup(chatId);
  }
});

test("un fallo de Telegram al silenciar no se presenta como éxito", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  try {
    resetSecurityCaches();
    const data = await getGroupData(chatId);
    data.promotion.infractions[String(USER_ID)] = 1;
    await saveGroupData(chatId, data);

    const { ctx, restricts, replies } = createCtx(chatId, 500, {
      restrictThrows: true,
    });
    await runFilter(ctx);

    assert.equal(restricts.length, 0, "el silencio falló");
    const dataAfter = await getGroupData(chatId);
    assert.ok(
      !replies.includes(dataAfter.promotion.messages.promotionMuted),
      "no se debe anunciar un silencio que falló",
    );
    assert.equal(replies.length, 1);
  } finally {
    await cleanup(chatId);
  }
});