import { Composer } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
  muteUser,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

interface UserSpamState {
  texts: string[];
  mediaKeys: string[];
}

const states = new Map<string, UserSpamState>();

function stateFor(groupId: number, userId: number): UserSpamState {
  const key = `${groupId}:${userId}`;
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const state: UserSpamState = { texts: [], mediaKeys: [] };
  states.set(key, state);
  return state;
}

function normalizeMessage(value: string): string {
  return value
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getText(ctx: MyContext): string {
  return ctx.message?.text ?? ctx.message?.caption ?? "";
}

function getEntities(ctx: MyContext): Array<{ type: string }> {
  const message = ctx.message;
  if (!message) {
    return [];
  }
  return [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];
}

function hasLink(ctx: MyContext, text: string): boolean {
  return (
    /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu.test(text) ||
    getEntities(ctx).some((entity) => entity.type === "url" || entity.type === "text_link")
  );
}

function mentionCount(ctx: MyContext): number {
  const entityMentions = getEntities(ctx).filter(
    (entity) => entity.type === "mention" || entity.type === "text_mention",
  ).length;
  const text = getText(ctx);
  const textualMentions = text.match(/(^|\s)@[a-z0-9_]{4,}/giu)?.length ?? 0;
  return Math.max(entityMentions, textualMentions);
}

function mediaKey(ctx: MyContext): string | undefined {
  const message = ctx.message;
  if (!message) return undefined;
  if ("sticker" in message && message.sticker) return `sticker:${message.sticker.file_id}`;
  if ("animation" in message && message.animation) return `animation:${message.animation.file_id}`;
  if ("video" in message && message.video) return `video:${message.video.file_id}`;
  if ("document" in message && message.document) return `document:${message.document.file_id}`;
  if ("audio" in message && message.audio) return `audio:${message.audio.file_id}`;
  if ("voice" in message && message.voice) return `voice:${message.voice.file_id}`;
  if ("video_note" in message && message.video_note) return `video_note:${message.video_note.file_id}`;
  if ("photo" in message && message.photo && message.photo.length > 0) {
    return `photo:${message.photo[message.photo.length - 1].file_id}`;
  }
  return undefined;
}

function similarToRecent(text: string, recent: string[]): boolean {
  if (!text) {
    return false;
  }
  return recent.some((previous) => {
    if (previous === text) {
      return true;
    }
    const left = new Set(text.split(" "));
    const right = new Set(previous.split(" "));
    const intersection = [...left].filter((word) => right.has(word)).length;
    return intersection >= 3 && intersection / Math.max(left.size, right.size) >= 0.8;
  });
}

function resetState(state: UserSpamState): void {
  state.texts = [];
  state.mediaKeys = [];
}

export const antiSpam = new Composer<MyContext>();

antiSpam.on("message", async (ctx, next) => {
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !ctx.message
  ) {
    await next();
    return;
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const data = await getGroupData(chatId);
  if (!data.antiSpam.enabled) {
    await next();
    return;
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isProtectedMember(member)
  ) {
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canDelete && !rights.canRestrict) {
    await next();
    return;
  }

  const state = stateFor(chatId, userId);

  const text = normalizeMessage(getText(ctx));
  const repeated =
    data.antiSpam.detectRepeatedMessages && similarToRecent(text, state.texts);
  const linkViolation = data.antiSpam.blockLinks && hasLink(ctx, getText(ctx));
  const mentionViolation = mentionCount(ctx) > data.antiSpam.maxMentionsPerMessage;
  const currentMediaKey = mediaKey(ctx);
  const mediaViolation =
    data.antiSpam.detectAutomatedBehavior &&
    Boolean(currentMediaKey && state.mediaKeys.includes(currentMediaKey));
  const reason = linkViolation
    ? "link"
    : mentionViolation
      ? "mentions"
      : mediaViolation
        ? "media-repeated"
        : repeated
          ? "repeated"
          : undefined;

  if (reason) {
    const deleted = rights.canDelete
      ? await ctx.api.deleteMessage(chatId, ctx.message.message_id).then(
          () => ({ ok: true }),
          () => ({ ok: false }),
        )
      : { ok: false };
    const key = String(userId);
    const infraction = (data.antiSpam.infractions[key] ?? 0) + 1;
    data.antiSpam.infractions[key] = infraction;
    await saveGroupData(chatId, data);

    let muted = false;
    if (infraction >= 2 && rights.canRestrict) {
      const minutes = [15, 60, 240, 1440][Math.min(infraction - 2, 3)] ?? 1440;
      muted = (await muteUser(ctx, chatId, userId, minutes, ctx.from.first_name)).ok;
    }
    try {
      const status = muted
        ? deleted.ok
          ? "⚠️ Spam detectado. Tu mensaje fue eliminado y has sido silenciado temporalmente."
          : "⚠️ Spam detectado. No se pudo eliminar tu mensaje, pero has sido silenciado temporalmente."
        : deleted.ok
          ? "⚠️ Spam detectado. Tu mensaje fue eliminado."
          : "⚠️ Spam detectado. No se pudo eliminar tu mensaje.";
      await ctx.reply(
        status,
      );
    } catch (error) {
      console.error("[ANTI-SPAM] No se pudo enviar la notificación:", error);
    }
    await logEvent(ctx, chatId, "ANTISPAM", {
      targetId: userId,
      targetName: ctx.from.username ?? ctx.from.first_name,
      result: deleted.ok ? "ok" : "error",
      detail: `ANTI_SPAM:${reason};delete=${deleted.ok};mute=${muted}`,
    });
    resetState(state);
    return;
  }

  if (currentMediaKey) state.mediaKeys = [...state.mediaKeys.slice(-2), currentMediaKey];
  if (text) {
    state.texts = [...state.texts.slice(-2), text];
  }
  await next();
});
