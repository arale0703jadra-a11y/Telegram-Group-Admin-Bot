import type { Message } from "@grammyjs/types";
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

export function containsUrl(message: Message): boolean {
  const entities = messageEntities(message);
  if (entities.some((entity) => entity.type === "url" || entity.type === "text_link")) {
    return true;
  }
  const text = messageText(message);
  return (
    /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu.test(text) ||
    /(?:^|[\s([{<@,;])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?/iu.test(
      text,
    )
  );
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
