import type { Message } from "@grammyjs/types";

type ScannableMessage = Pick<
  Message,
  "text" | "caption" | "entities" | "caption_entities"
>;

export interface ScannableMessageContent {
  text: string;
  entities: NonNullable<Message["entities"]>;
}

export function getScannableMessageContent(
  message: ScannableMessage,
): ScannableMessageContent {
  return {
    text: message.text ?? message.caption ?? "",
    entities: [...(message.entities ?? []), ...(message.caption_entities ?? [])],
  };
}
