import type { AutomaticMessageConfig } from "../storage/types.js";
import type { AutomaticMessageMediaDraft } from "../types.js";

/**
 * Construcción pura de configuraciones de mensajes recurrentes.
 *
 * Se mantiene fuera de los handlers para poder probar, sin tocar disco ni
 * Telegram, cómo se combina el contenido nuevo (texto o multimedia) con los
 * campos de programación y estado que ya existían.
 */

function baseConfig(
  current: AutomaticMessageConfig | undefined,
  now: () => number,
): AutomaticMessageConfig {
  const intervalMinutes = current?.intervalMinutes ?? 60;
  return {
    ...current,
    enabled: current?.enabled ?? false,
    intervalMinutes,
    nextRunAt: current?.enabled
      ? new Date(now() + intervalMinutes * 60_000).toISOString()
      : current?.nextRunAt,
    lastSentAt: current?.lastSentAt,
    lastMessageId: current?.lastMessageId,
  };
}

export function buildAutomaticMessageTextConfig(
  current: AutomaticMessageConfig | undefined,
  message: string,
  now: () => number = Date.now,
): AutomaticMessageConfig {
  return {
    ...baseConfig(current, now),
    type: "text",
    message,
    fileId: undefined,
    caption: undefined,
    captionEntities: undefined,
    entities: undefined,
  };
}

export function buildAutomaticMessageMediaConfig(
  current: AutomaticMessageConfig | undefined,
  draft: AutomaticMessageMediaDraft,
  now: () => number = Date.now,
): AutomaticMessageConfig {
  return {
    ...baseConfig(current, now),
    type: draft.type,
    fileId: draft.fileId,
    caption: draft.caption,
    captionEntities: draft.captionEntities,
    message: undefined,
    entities: undefined,
  };
}