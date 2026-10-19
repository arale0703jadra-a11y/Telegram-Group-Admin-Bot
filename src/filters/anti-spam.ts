import { Composer } from "grammy";
import { getGroupData, saveGroupData } from "../storage/index.js";
import {
  getBotRights,
  getMemberSafely,
  isVerifiableMember,
  muteUser,
  deleteMessageById,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import {
  CooldownTracker,
  KeyedMutex,
  SlidingWindowCounter,
} from "../utils/safety.js";
import { expireEmergencyIfNeeded, isEmergencyActive } from "./anti-raid-engine.js";
import { isExemptFromAutomaticSanction } from "./exemptions.js";
import { mediaKey, similarToRecent } from "../utils/message-signals.js";
import { inspectLinks } from "./link-filter.js";
import type { MessageEntity } from "@grammyjs/types";
import type { MyContext } from "../types.js";
import { getVerifiedUserPermissions } from "../services/verified-users.js";
import { shouldSkipOrdinarySpamViolation } from "../services/verified-user-policy.js";

interface UserSpamState {
  texts: string[];
  mediaKeys: string[];
}

const states = new Map<string, UserSpamState>();
const rateLimiter = new SlidingWindowCounter();
const muteCooldown = new CooldownTracker();
const mutex = new KeyedMutex();

/** Cooldown para no repetir el mismo silencio automático seguido. */
const MUTE_COOLDOWN_MS = 60 * 1000;

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

function getEntities(ctx: MyContext): MessageEntity[] {
  const message = ctx.message;
  if (!message) {
    return [];
  }
  return [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];
}

function mentionCount(ctx: MyContext): number {
  const entityMentions = getEntities(ctx).filter(
    (entity) => entity.type === "mention" || entity.type === "text_mention",
  ).length;
  const text = getText(ctx);
  const textualMentions = text.match(/(^|\s)@[a-z0-9_]{4,}/giu)?.length ?? 0;
  return Math.max(entityMentions, textualMentions);
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
  const messageId = ctx.message.message_id;
  const now = Date.now();

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member || member.user.is_bot || !isVerifiableMember(member)) {
    await next();
    return;
  }

  const data = await getGroupData(chatId);
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);
  if (!data.antiSpam.enabled || isExemptFromAutomaticSanction(data, userId, member)) {
    await saveGroupData(chatId, data);
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  if (!rights.canDelete && !rights.canRestrict) {
    await saveGroupData(chatId, data);
    await next();
    return;
  }

  // En modo de emergencia los límites se endurecen para no exentos.
  const emergency = isEmergencyActive(data.emergency, now);
  const effectiveBlockLinks = data.antiSpam.blockLinks || emergency;
  const effectiveMaxMessages = emergency
    ? Math.max(3, Math.floor(data.antiSpam.maxMessagesPerWindow / 2))
    : data.antiSpam.maxMessagesPerWindow;
  const windowMs = data.antiSpam.windowSeconds * 1000;

  const state = stateFor(chatId, userId);
  const rawText = getText(ctx);
  const text = normalizeMessage(rawText);
  const links = inspectLinks(rawText, getEntities(ctx));

  const rateExceeded =
    data.antiSpam.rateLimitEnabled &&
    rateLimiter.record(`${chatId}:${userId}`, now, windowMs) >
      effectiveMaxMessages;

  const inviteViolation =
    data.antiSpam.blockInvites && links.hasUnauthorizedInvite;
  const linkViolation =
    effectiveBlockLinks &&
    links.hasUnauthorizedLink &&
    !inviteViolation;
  const mentionViolation = mentionCount(ctx) > data.antiSpam.maxMentionsPerMessage;
  const currentMediaKey = mediaKey(ctx.message);
  const mediaViolation =
    data.antiSpam.detectAutomatedBehavior &&
    Boolean(currentMediaKey && state.mediaKeys.includes(currentMediaKey));
  const repeated =
    data.antiSpam.detectRepeatedMessages && similarToRecent(text, state.texts);

  const reason = rateExceeded
    ? "rate"
    : inviteViolation
      ? "invite"
      : linkViolation
        ? "link"
        : mentionViolation
          ? "mentions"
          : mediaViolation
            ? "media-repeated"
            : repeated
              ? "repeated"
              : undefined;

  if (reason) {
    const verifiedPermissions = await getVerifiedUserPermissions(chatId, userId);
    const verifiedCanPostLinks =
      (reason === "link" || reason === "invite") &&
      verifiedPermissions?.can_send_links === true;
    const verifiedSkipsSpam =
      verifiedPermissions && reason !== "link" && reason !== "invite"
      ? shouldSkipOrdinarySpamViolation(
          verifiedPermissions.bypass_antispam,
          reason === "repeated" ? "repeat_offender" : reason,
        )
      : false;
    if (verifiedCanPostLinks || verifiedSkipsSpam) {
      if (currentMediaKey) state.mediaKeys = [...state.mediaKeys.slice(-2), currentMediaKey];
      if (text) state.texts = [...state.texts.slice(-2), text];
      await saveGroupData(chatId, data);
      await next();
      return;
    }
  }

  if (!reason) {
    if (currentMediaKey) state.mediaKeys = [...state.mediaKeys.slice(-2), currentMediaKey];
    if (text) state.texts = [...state.texts.slice(-2), text];
    await saveGroupData(chatId, data);
    await next();
    return;
  }

  // Serializa la sanción por chat para no duplicar infractions/silencios.
  const outcome = await mutex.runExclusive(String(chatId), async () => {
    const deleted = rights.canDelete
      ? await deleteMessageById(ctx, chatId, messageId)
      : { ok: false };
    const key = String(userId);
    const infraction = (data.antiSpam.infractions[key] ?? 0) + 1;
    data.antiSpam.infractions[key] = infraction;
    await saveGroupData(chatId, data);

    let muted = false;
    const canMuteNow =
      infraction >= 2 &&
      rights.canRestrict &&
      muteCooldown.shouldApply(`${chatId}:${userId}:spam`, now, MUTE_COOLDOWN_MS);
    if (canMuteNow) {
      const minutes = [15, 60, 240, 1440][Math.min(infraction - 2, 3)] ?? 1440;
      muted = (await muteUser(ctx, chatId, userId, minutes, ctx.from!.first_name)).ok;
    }
    return { deleted: deleted.ok, muted };
  });

  await logEvent(ctx, chatId, "ANTISPAM", {
    targetId: userId,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: outcome.deleted ? "ok" : "error",
    detail: `ANTI_SPAM:${reason};delete=${outcome.deleted};mute=${outcome.muted};emergency=${emergency}`,
  });
  resetState(state);
  return;
});
