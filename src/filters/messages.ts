import type { PromotionConfig } from "../storage/types.js";

export function buildPromotionMessage(
  config: PromotionConfig,
  kind: "warning" | "removed" | "muted" | "link",
): string {
  const base = {
    warning: config.messages.promotionWarning,
    removed: config.messages.promotionRemoved,
    muted: config.messages.promotionMuted,
    link: config.messages.linkWarning,
  }[kind];
  const contacts = config.verificationContacts.join("\n");
  return `${base}\n\n${config.messages.verificationRequired}${
    contacts ? `\n\n🔐 Verifícate con:\n${contacts}` : ""
  }`;
}
