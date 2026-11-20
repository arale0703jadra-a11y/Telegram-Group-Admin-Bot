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
  type ActionResult,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { sanitizeLogText } from "../utils/safety.js";
import { isExemptFromAutomaticSanction } from "./exemptions.js";
import { isGroupChat } from "../utils/permissions.js";
import {
  isEmergencyActive,
  expireEmergencyIfNeeded,
  isRecentEmergencyMember,
} from "./anti-raid-engine.js";
import { getScannableMessageContent } from "./message-content.js";
import { getVerifiedUserPermissions } from "../services/verified-users.js";
import type { MyContext } from "../types.js";

export type LinkKind =
  | "externo"
  | "invitacion"
  | "privado-telegram"
  | "publico-telegram";

export interface LinkInspection {
  hasLink: boolean;
  hasInvite: boolean;
  hasUnauthorizedLink: boolean;
  hasUnauthorizedInvite: boolean;
  /** Enlace privado de Telegram (`t.me/c/...`): chat no público. */
  hasPrivateTelegramLink: boolean;
  /** Enlace hacia un dominio que no pertenece a Telegram. */
  hasExternalLink: boolean;
  /** Categorías presentes en el mensaje, para la auditoría. */
  kinds: readonly LinkKind[];
  blockedMention?: string;
}

const LINK_PATTERN =
  /(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59}))(?::\d{1,5})?(?:\/[^\s<>()]*)?/giu;
const TELEGRAM_HANDLE_PATTERN = /@[a-z][a-z0-9_]{4,31}/giu;
const INVITE_PATH_PATTERN = /\/(?:\+|joinchat\/)/iu;
/** Ruta de chat privado de Telegram: `t.me/c/<id interno>/<mensaje>`. */
const PRIVATE_PATH_PATTERN = /^\/c\/\d+/iu;
/** Hosts de Telegram que admiten invitaciones y enlaces privados. */
const TELEGRAM_HOSTS: ReadonlySet<string> = new Set([
  "t.me",
  "telegram.me",
  "telegram.dog",
]);

/**
 * Extensiones de archivo habituales. Un token `nombre.extensión` sin
 * esquema, sin ruta y sin prefijo `www.` se trata como NOMBRE DE ARCHIVO y
 * no como dominio, para no bloquear `informe.pdf`, `foto.jpg`, `archivo.zip`.
 * Excluidas las extensiones que son también TLD reales (.ai, .sh, .rs, .py,
 * .md, .in, .id, .me, .is, .im, .ms…) a fin de no debilitar la detección de
 * dominios reales. `.zip` y `.mov` sí son gTLD pero son mayoritariamente
 * archivos: un token así sin esquema ni ruta deja de auto-detectarse como
 * dominio, y sigue detectándose con `http(s)://`, `www.` o una ruta.
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf",
  "odt", "epub", "mobi", "jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp",
  "svg", "psd", "eps", "heic", "raw", "mp4", "mkv", "avi", "wmv", "flv",
  "webm", "m4v", "mpeg", "3gp", "ogv", "mp3", "wav", "flac", "aac", "m4a",
  "wma", "aiff", "opus", "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz",
  "iso", "exe", "msi", "dmg", "apk", "deb", "rpm", "pkg", "bin", "jar",
  "html", "htm", "css", "js", "jsx", "ts", "tsx", "json", "xml", "yml",
  "yaml", "php", "log", "bak", "tmp", "dat", "db", "sqlite", "ico", "ttf",
  "otf", "woff", "woff2", "wasm",
]);

function isTelegramHost(host: string): boolean {
  return TELEGRAM_HOSTS.has(host);
}

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
  /** Enlace privado de Telegram (`t.me/c/...`). */
  isPrivate: boolean;
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
    .replace(/[\p{Cf}\p{Cc}]/gu, "")
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
  const telegram = isTelegramHost(host);
  return {
    host,
    path,
    invite: telegram && INVITE_PATH_PATTERN.test(path),
    isPrivate: telegram && PRIVATE_PATH_PATTERN.test(path),
  };
}

/**
 * Un token sin esquema, sin ruta y con una extensión de archivo conocida es
 * un nombre de archivo, no un dominio (`informe.pdf`, `video.mp4`).
 */
function isBareFileName(value: string): boolean {
  const cleaned = value.replace(/[.,;:!?]+$/u, "");
  if (cleaned.includes("/") || cleaned.includes(":")) return false;
  if (cleaned.toLocaleLowerCase("en").startsWith("www.")) return false;
  const labels = cleaned.toLocaleLowerCase("en").split(".");
  if (labels.length < 2) return false;
  return FILE_EXTENSIONS.has(labels[labels.length - 1] ?? "");
}

/**
 * Token completo que empieza en `index`. El patrón de dominios recorta las
 * extensiones con dígitos (`video.mp4` produce la coincidencia `video.mp`),
 * por lo que el nombre de archivo se evalúa sobre el token entero y no
 * sobre la coincidencia parcial.
 */
function tokenAt(normalized: string, index: number): string {
  const rest = normalized.slice(index);
  const boundary = rest.search(/[\s<>()]/u);
  return (boundary === -1 ? rest : rest.slice(0, boundary)).replace(
    /[.,;:!?]+$/u,
    "",
  );
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
    if (isBareFileName(tokenAt(normalized, match.index ?? 0))) {
      continue;
    }
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
      continue;
    }
    if (entity.type === "url") {
      // Los offsets de Telegram son unidades UTF-16, igual que String.slice,
      // y son relativos al texto ORIGINAL del mensaje.
      const entityText = text.slice(entity.offset, entity.offset + entity.length);
      const link = entityText ? linkFromUrl(entityText) : undefined;
      if (link) {
        found.push(link);
      }
    }
  }

  for (const match of normalized.matchAll(TELEGRAM_HANDLE_PATTERN)) {
    const handle = match[0].slice(1).toLocaleLowerCase("en");
    found.push({ handle, invite: false, isPrivate: false });
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
    // Los enlaces privados de Telegram (`t.me/c/...`) nunca se consideran
    // autorizados: la política exige bloquearlos mientras esté activa, con o
    // sin whitelist. El resto sigue dependiendo de la whitelist explícita.
    unauthorized: link.isPrivate ? true : !isWhitelisted(link, whitelist),
  }));
  const blockedMention = mentionsBlocked
    ? classified.find(
        ({ link, unauthorized }) => unauthorized && Boolean(link.handle),
      )?.link.handle
    : undefined;
  const linkEntries = classified.filter(({ link }) => !link.handle);
  const kinds = new Set<LinkKind>();
  for (const { link } of linkEntries) {
    if (link.isPrivate) kinds.add("privado-telegram");
    else if (link.invite) kinds.add("invitacion");
    else if (link.host && isTelegramHost(link.host)) kinds.add("publico-telegram");
    else kinds.add("externo");
  }

  return {
    hasLink: linkEntries.length > 0 || Boolean(blockedMention),
    hasInvite: linkEntries.some(({ link }) => link.invite),
    hasUnauthorizedLink: linkEntries.some(({ unauthorized }) => unauthorized),
    hasUnauthorizedInvite: linkEntries.some(
      ({ link, unauthorized }) =>
        (link.invite || link.isPrivate) && unauthorized,
    ),
    hasPrivateTelegramLink: linkEntries.some(({ link }) => link.isPrivate),
    hasExternalLink: linkEntries.some(
      ({ link }) => link.host !== undefined && !isTelegramHost(link.host),
    ),
    kinds: [...kinds],
    blockedMention,
  };
}

export const linkFilter = new Composer<MyContext>();

/**
 * Evita sanciones y registros duplicados cuando Telegram reenvía el mismo
 * contenido o el usuario repite una edición idéntica en la misma ventana.
 */
const handledLinkViolations = new Map<string, { digest: string; expiresAt: number }>();
const LINK_VIOLATION_DEDUPE_MS = 5 * 60 * 1000;
const MAX_TRACKED_LINK_VIOLATIONS = 2_048;

function contentDigest(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return `${value.length}:${hash}`;
}

function pruneHandledLinkViolations(now: number): void {
  for (const [key, entry] of handledLinkViolations) {
    if (entry.expiresAt <= now) handledLinkViolations.delete(key);
  }
}

function rememberLinkViolation(key: string, digest: string, now: number): void {
  handledLinkViolations.set(key, {
    digest,
    expiresAt: now + LINK_VIOLATION_DEDUPE_MS,
  });
  if (handledLinkViolations.size > MAX_TRACKED_LINK_VIOLATIONS) {
    const oldest = handledLinkViolations.keys().next().value;
    if (oldest !== undefined) handledLinkViolations.delete(oldest);
  }
}

function violationKindsLabel(links: LinkInspection): string {
  return links.kinds.join("+") || "desconocido";
}

/**
 * Política de enlaces del grupo.
 *
 * - Analiza `message` Y `edited_message`: un usuario no puede enviar un
 *   mensaje válido y editarlo después para añadir un enlace prohibido.
 * - Es independiente del interruptor maestro de anti-spam: desactivar
 *   anti-spam no apaga esta protección; solo `blockLinks`/`blockInvites`
 *   (configuración explícita de cada grupo) la desactivan.
 * - Las excepciones existentes (`can_send_links` de verificadas y exentos
 *   de sanción automática) se conservan intactas y además se AUDITAN aquí:
 *   no se añade ninguna excepción nueva.
 * - Nunca banea solo por compartir un enlace: aplica la advertencia
 *   configurada del grupo (warnLimit/warnAction).
 */
linkFilter.on(["message", "edited_message"], async (ctx, next) => {
  // `ctx.msg` cubre `message` y `edited_message`; `ctx.message` es
  // `undefined` en los mensajes editados y los dejaría sin analizar.
  const message = ctx.msg;
  if (
    !isGroupChat(ctx) ||
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    !message
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
  const now = Date.now();
  data.emergency = expireEmergencyIfNeeded(data.emergency, now);
  const emergency = isEmergencyActive(data.emergency, now);
  const emergencyRestriction =
    emergency &&
    isRecentEmergencyMember(data.indexedUsers[String(userId)]?.joinedAt, now);

  const blockLinks = data.antiSpam.blockLinks || emergencyRestriction;
  const blockInvites = data.antiSpam.blockInvites || emergencyRestriction;
  if (!blockLinks && !blockInvites) {
    await next();
    return;
  }

  const content = getScannableMessageContent(message);
  const links = inspectLinks(content.text, content.entities);
  const violation =
    (blockInvites && links.hasUnauthorizedInvite) ||
    (blockLinks && (links.hasUnauthorizedLink || Boolean(links.blockedMention)));
  if (!violation) {
    await next();
    return;
  }

  const targetName = ctx.from.username ?? ctx.from.first_name;
  const kinds = violationKindsLabel(links);
  const edited = "edited_message" in ctx.update;

  // Excepciones EXPLÍCITAS de otros subsistemas, aquí siempre auditadas.
  const verifiedPermissions = await getVerifiedUserPermissions(chatId, userId);
  if (verifiedPermissions?.can_send_links && !emergencyRestriction) {
    await logEvent(ctx, chatId, "ANTISPAM", {
      targetId: userId,
      targetName,
      result: "rejected",
      detail: `LINK_FILTER:exenta=verified_can_send_links;tipos=${kinds};editado=${edited}`,
    });
    await next();
    return;
  }
  if (isExemptFromAutomaticSanction(data, userId, member)) {
    await logEvent(ctx, chatId, "ANTISPAM", {
      targetId: userId,
      targetName,
      result: "rejected",
      detail: `LINK_FILTER:exenta=sancion_automatica;tipos=${kinds};editado=${edited}`,
    });
    await next();
    return;
  }

  const violationKey = `${chatId}:${message.message_id}`;
  pruneHandledLinkViolations(now);
  const digest = contentDigest(`${content.text}|${kinds}`);
  if (handledLinkViolations.get(violationKey)?.digest === digest) {
    // Mismo mensaje y mismo contenido ya sancionado: no se duplica.
    return;
  }
  rememberLinkViolation(violationKey, digest, now);

  const rights = await getBotRights(ctx, chatId);
  let deletion: ActionResult;
  if (!rights.canDelete) {
    deletion = { ok: false, error: "El bot no tiene permiso para borrar mensajes." };
  } else {
    try {
      deletion = await deleteMessageById(ctx, chatId, message.message_id);
    } catch (error) {
      deletion = {
        ok: false,
        error: error instanceof Error ? error.message : "error desconocido",
      };
    }
  }

  const warning = await warnUser(
    ctx,
    chatId,
    userId,
    targetName,
    `Enlace no autorizado${links.hasUnauthorizedInvite ? " (invitación)" : ""}` +
      `${links.hasPrivateTelegramLink ? " (enlace privado de Telegram)" : ""}.`,
  );

  await logEvent(ctx, chatId, "ANTISPAM", {
    targetId: userId,
    targetName,
    result: deletion.ok && warning.ok ? "ok" : "error",
    detail:
      `LINK_FILTER:delete=${deletion.ok};warning=${warning.ok};` +
      `invite=${links.hasUnauthorizedInvite};privado=${links.hasPrivateTelegramLink};` +
      `mention=${Boolean(links.blockedMention)};tipos=${kinds};editado=${edited}` +
      (deletion.ok ? "" : `;deleteError=${sanitizeLogText(deletion.error ?? "")}`) +
      (warning.ok ? "" : `;warnError=${sanitizeLogText(warning.error ?? "")}`),
  });
});
