import type { PromotionConfig } from "../storage/types.js";

export function buildPromotionMessage(
  config: PromotionConfig,
): string {
  const contacts = config.verificationContacts.join("\n");
  return `${config.messages.verificationRequired}${
    contacts ? `\n\n🔐 Verifícate con:\n${contacts}` : ""
  }`;
}
