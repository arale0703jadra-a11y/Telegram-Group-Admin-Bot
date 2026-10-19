import type { ChatMember } from "@grammyjs/types";
import { OWNER_ID } from "../config.js";
import { isProtectedMember } from "../moderation/actions.js";
import type { GroupData } from "../storage/types.js";

/**
 * Exenciones de las sanciones automáticas de spam/raid.
 *
 * Están pensadas para administradores, el propietario del sistema y cuentas
 * de confianza explícitas. NUNCA se basan en el nombre, la foto o la
 * antigüedad de la cuenta. La lista de confianza se guarda por grupo en
 * `data.trustedUsers` (clave = id de usuario como texto).
 */
export function isTrustedUser(data: GroupData, userId: number): boolean {
  return data.trustedUsers[String(userId)] === true;
}

/**
 * `true` si el usuario queda exento de las sanciones automáticas de
 * spam/raid. Solo el OWNER, los administradores de Telegram y las cuentas
 * de confianza configuradas. El contenido ilegal explícito NO se exime.
 */
export function isExemptFromAutomaticSanction(
  data: GroupData,
  userId: number,
  member: ChatMember | undefined,
): boolean {
  if (OWNER_ID === userId) {
    return true;
  }
  if (isTrustedUser(data, userId)) {
    return true;
  }
  return member ? isProtectedMember(member) : false;
}
