import type { Message, MessageEntity } from "@grammyjs/types";
import { inspectLinks } from "../filters/link-filter.js";
import { sanitizeIncomingText } from "./sanitizer.js";

export function messageText(message: Message): string {
  if ("text" in message && typeof message.text === "string") {
    return sanitizeIncomingText(message.text);
  }
  if ("caption" in message && typeof message.caption === "string") {
    return sanitizeIncomingText(message.caption);
  }
  return "";
}

export function messageEntities(message: Message): readonly { type: string }[] {
  if ("entities" in message && Array.isArray(message.entities)) {
    return message.entities;
  }
  if ("caption_entities" in message && Array.isArray(message.caption_entities)) {
    return message.caption_entities;
  }
  return [];
}

/**
 * Texto ORIGINAL del mensaje (sin sanitizar): los offsets de las entidades
 * de Telegram se calculan sobre este texto, y el detector centralizado
 * normaliza por su cuenta el contenido entrante.
 */
function rawMessageText(message: Message): string {
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

/**
 * Detector centralizado de enlaces: reutiliza `inspectLinks` (el mismo que
 * usa la política de enlaces del grupo) para que la cuarentena, el
 * confinamiento de emergencia y el filtro no interpreten el mismo mensaje
 * con reglas distintas.
 */
export function containsUrl(message: Message): boolean {
  const entities: MessageEntity[] = [
    ...("entities" in message && Array.isArray(message.entities)
      ? message.entities
      : []),
    ...("caption_entities" in message && Array.isArray(message.caption_entities)
      ? message.caption_entities
      : []),
  ];
  return inspectLinks(rawMessageText(message), entities).hasLink;
}

export function containsMention(message: Message): boolean {
  const entities = messageEntities(message);
  if (
    entities.some(
      (entity) => entity.type === "mention" || entity.type === "text_mention",
    )
  ) {
    return true;
  }
  return /@[A-Za-z0-9_]{5,}/u.test(messageText(message));
}

export function containsEmergencyMedia(message: Message): boolean {
  return (
    ("photo" in message && Boolean(message.photo?.length)) ||
    ("video" in message && Boolean(message.video)) ||
    ("animation" in message && Boolean(message.animation)) ||
    ("document" in message && Boolean(message.document)) ||
    ("audio" in message && Boolean(message.audio)) ||
    ("voice" in message && Boolean(message.voice)) ||
    ("video_note" in message && Boolean(message.video_note)) ||
    ("sticker" in message && Boolean(message.sticker))
  );
}
