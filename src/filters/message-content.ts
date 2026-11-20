import type { Message } from "@grammyjs/types";

type ScannableMessage = Pick<
  Message,
  "text" | "caption" | "entities" | "caption_entities"
>;

export interface ScannableMessageContent {
  text: string;
  entities: NonNullable<Message["entities"]>;
}

/**
 * Devuelve el texto y las entidades ORIGINALES del mensaje, sin sanitizar.
 *
 * Los offsets de las entidades de Telegram se calculan sobre el texto que
 * el bot recibió: recortar caracteres antes de leerlas desalinearía una
 * entidad `url` y dejaría de detectarse. La defensa contra caracteres de
 * control, invisibles, homóglifos y ofuscación vive en el detector
 * centralizado (`inspectLinks` → `normalizeLinkText`), no aquí.
 */
export function getScannableMessageContent(
  message: ScannableMessage,
): ScannableMessageContent {
  return {
    text: message.text ?? message.caption ?? "",
    entities: [...(message.entities ?? []), ...(message.caption_entities ?? [])],
  };
}
