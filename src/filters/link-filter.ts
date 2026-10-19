import type { MessageEntity } from "@grammyjs/types";
import { Composer } from "grammy";
import { domainToASCII } from "node:url";
import {
  LINK_FILTER_BLOCK_MENTIONS,
  LINK_WHITELIST,
} from "../config.js";
import { getGroupData } from "../storage/index.js";
import {
  getBotRights,
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
  warnUser,
  deleteMessageById,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isExemptFromAutomaticSanction } from "./exemptions.js";
import { isGroupChat } from "../utils/permissions.js";
import { isEmergencyActive, expireEmergencyIfNeeded } from "./anti-raid-engine.js";
import { replyWithAutoDelete } from "../utils/cleanup.js";
import type { MyContext } from "../types.js";

export interface LinkInspection {
  hasLink: boolean;
  hasInvite: boolean;
  hasUnauthorizedLink: boolean;
  hasUnauthorizedInvite: boolean;
  blockedMention?: string;
}

const LINK_PATTERN =
  /(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59}))(?::\d{1,5})?(?:\/[^\s<>()]*)?/giu;
const TELEGRAM_HANDLE_PATTERN = /@[a-z][a-z0-9_]{4,31}/giu;
const INVITE_PATH_PATTERN = /\/(?:\+|joinchat\/)/iu;

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ӏ: "l",
};

interface FoundLink {
  host?: string;
  path?: string;
  handle?: string;
  invite: boolean;
}

interface WhitelistEntry {
  host?: string;
  path?: string;
  handle?: string;
}

function normalizeLinkText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u3002\uff0e\uff61]/gu, ".")
    .replace(/[\s\S]/gu, (character) => HOMOGLYPHS[character] ?? character)
    .replace(/\bhxxps?(?=:)/giu, (value) =>
      value.endsWith("s") ? "https" : "http",
    )
    .replace(/(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\s+dot\s+)/giu, ".")
    .replace(/\s*\.\s*/gu, ".");
}

function normalizeHost(value: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/^\.+|\.+$/gu, "")
    .replace(/^www\./u, "");
  return domainToASCII(normalized) || normalized;
}

function normalizeWhitelistEntry(value: string): WhitelistEntry {
  const normalized = normalizeLinkText(value).trim();
  if (normalized.startsWith("@")) {
    return { handle: normalized.slice(1).toLocaleLowerCase("en") };
  }

  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
      ? normalized
      : `https://${normalized}`;
    const url = new URL(candidate);
    const path = url.pathname.replace(/\/+$/u, "");
    return {
      host: normalizeHost(url.hostname),
      path: path || undefined,
    };
  } catch {
    return {};
  }
}

function isWhitelisted(link: FoundLink, whitelist: readonly string[]): boolean {
  return whitelist.some((entry) => {
    const allowed = normalizeWhitelistEntry(entry);
    if (link.handle && allowed.handle === link.handle.toLocaleLowerCase("en")) {
      return true;
    }
    if (!link.host || !allowed.host) {
      return false;
    }
    const hostMatches =
      link.host === allowed.host || link.host.endsWith(`.${allowed.host}`)
    const pathMatches =
      !allowed.path ||
      link.path === allowed.path ||
      link.path?.startsWith(`${allowed.path}/`);
    return hostMatches && pathMatches;
  });
}

function linkFromUrl(value: string): FoundLink | undefined {
  const normalized = normalizeLinkText(value);
  const candidate = /^(?:https?:\/\/)?([^/?#]+)([^#]*)/u.exec(normalized);
  if (!candidate?.[1]) {
    return undefined;
  }
  const host = normalizeHost(candidate[1].split(":")[0] ?? "");
  if (!host || !host.includes(".")) {
    return undefined;
  }
  const path = candidate[2] ?? "";
  return {
    host,
    path,
    invite:
      (host === "t.me" ||
        host === "telegram.me" ||
        host === "telegram.dog") &&
      INVITE_PATH_PATTERN.test(path),
  };
}

function findLinks(
  text: string,
  entities: readonly MessageEntity[],
): FoundLink[] {
  const normalized = normalizeLinkText(text);
  const found: FoundLink[] = [];
  for (const match of normalized.matchAll(LINK_PATTERN)) {
    const precedingCharacter = match.index
      ? normalized[match.index - 1]
      : undefined;
    const hasUrlSchemeBefore = /(?:https?:\/\/|hxxps?:\/\/)[^\s]*$/iu.test(
      normalized.slice(0, match.index),
    );
    if (precedingCharacter === "@" && !hasUrlSchemeBefore) {
      continue;
    }
    const value = match[0];
    const link = linkFromUrl(value);
    if (link) {
      found.push(link);
    }
  }

  for (const entity of entities) {
    if (entity.type === "text_link" && entity.url) {
      const link = linkFromUrl(entity.url);
      if (link) {
        found.push(link);
      }
    }
  }

  for (const match of normalized.matchAll(TELEGRAM_HANDLE_PATTERN)) {
    const handle = match[0].slice(1).toLocaleLowerCase("en");
    found.push({ handle, invite: false });
  }

  return found;
}

export function inspectLinks(
  text: string,
  entities: readonly MessageEntity[] = [],
  options: {
    whitelist?: readonly string[];
    blockMentions?: boolean;
  } = {},
): LinkInspection {
  const links = findLinks(text, entities);
  const whitelist = options.whitelist ?? LINK_WHITELIST;
  const mentionsBlocked = options.blockMentions ?? LINK_FILTER_BLOCK_MENTIONS;
  const classified = links.map((link) => ({
    link,
    unauthorized: !isWhitelisted(link, whitelist),
  }));
  const blockedMention = mentionsBlocked
    ? classified.find(
        ({ link, unauthorized }) => unauthorized && Boolean(link.handle),
      )?.link.handle
    : undefined;
  const linkEntries = classified.filter(({ link }) => !link.handle);

  return {
    hasLink: linkEntries.length > 0 || Boolean(blockedMention),
    hasInvite: linkEntries.some(({ link }) => link.invite),
    hasUnauthorizedLink: linkEntries.some(({ unauthorized }) => unauthorized),
    hasUnauthorizedInvite: linkEntries.some(
      ({ link, unauthorized }) => link.invite && unauthorized,
    ),
    blockedMention,
  };
}

function getMessageText(ctx: MyContext): string {
  return ctx.message?.text ?? ctx.message?.caption ?? "";
}

function getMessageEntities(ctx: MyContext): MessageEntity[] {
  return [
    ...(ctx.message?.entities ?? []),
    ...(ctx.message?.caption_entities ?? []),
  ];
}

export const linkFilter = new Composer<MyContext>();

linkFilter.on("message", async (ctx, next) => {
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

  const data = await getGroupData(chatId);
  if (!data.antiSpam.enabled || isExemptFromAutomaticSanction(data, userId, member)) {
    await next();
    return;
  }

  const now = Date.now();
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);
  const emergency = isEmergencyActive(data.emergency, now);
  const links = inspectLinks(getMessageText(ctx), getMessageEntities(ctx));
  const blockLinks = data.antiSpam.blockLinks || emergency;
  const violation =
    (data.antiSpam.blockInvites && links.hasUnauthorizedInvite) ||
    (blockLinks && links.hasUnauthorizedLink) ||
    Boolean(links.blockedMention);
  if (!violation) {
    await next();
    return;
  }

  const rights = await getBotRights(ctx, chatId);
  const deletion = rights.canDelete
    ? await deleteMessageById(ctx, chatId, ctx.message.message_id)
    : { ok: false, error: "El bot no tiene permiso para borrar mensajes." };
  const warning = await warnUser(
    ctx,
    chatId,
    userId,
    ctx.from.username ?? ctx.from.first_name,
    `Enlace no autorizado${links.hasUnauthorizedInvite ? " (invitación)" : ""}.`,
  );

  await logEvent(ctx, chatId, "ANTISPAM", {
    targetId: userId,
    targetName: ctx.from.username ?? ctx.from.first_name,
    result: deletion.ok ? "ok" : "error",
    detail:
      `LINK_FILTER:delete=${deletion.ok};warning=${warning.ok};` +
      `invite=${links.hasUnauthorizedInvite};mention=${Boolean(links.blockedMention)}`,
  });

  try {
    await replyWithAutoDelete(
      ctx,
      deletion.ok
        ? warning.ok
          ? "⚠️ Eliminé el enlace no autorizado y registré una advertencia."
          : "⚠️ Eliminé el enlace no autorizado."
        : "⚠️ Detecté un enlace no autorizado, pero no pude eliminar el mensaje.",
    );
  } catch (error) {
    console.error(
      `[LINK FILTER] No se pudo publicar el aviso (chatId=${chatId}, error=${error instanceof Error ? error.name : "unknown"}).`,
    );
  }
});
