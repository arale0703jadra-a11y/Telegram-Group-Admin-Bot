/**
 * Señales puras de mensajes para los filtros de spam.
 *
 * Módulo independiente de grammY, configuración y almacenamiento para poder
 * probarlo de forma aislada (sin leer .env ni contactar con Telegram).
 *
 * Capacidad de inspección real (Bot API): el texto y las entidades de texto,
 * la leyenda de los medios (caption + caption_entities) y los identificadores
 * de archivo (file_id) de fotos, vídeos, animaciones, documentos, audio, voz,
 * video_notas y stickers. NO permite inspeccionar el contenido binario de los
 * archivos (p. ej. texto dentro de una imagen), ni el contenido de enlaces.
 */
import type { Message } from "@grammyjs/types";

/**
 * Clave estable de un medio enviado por un usuario. Se usa para detectar el
 * reenvío repetido del mismo archivo (automatización/spam de medios).
 */
export function mediaKey(message: Message | undefined): string | undefined {
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

/**
 * Detecta textos repetidos o casi repetidos respecto a los últimos del
 * usuario. "Casi repetido" = al menos 3 palabras en común y ≥80 % de
 * solapamiento léxico.
 */
export function similarToRecent(text: string, recent: string[]): boolean {
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