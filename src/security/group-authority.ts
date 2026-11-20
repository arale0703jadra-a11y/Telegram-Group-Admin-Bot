import type { ChatMember } from "@grammyjs/types";
import {
  getCachedChatMember,
  type MemberLookupApi,
} from "../utils/member-cache.js";
import type { SecurityAction } from "../services/security-commands.js";

/**
 * Autoridad del operador dentro del grupo concreto (Fase 4).
 *
 * Mismo patrón que `src/security/admin-guardian.ts`: el estado se consulta a
 * Telegram y se interpreta con permisos concretos, nunca con un registro local.
 * La consulta falla cerrada (`undefined` ⇒ sin autoridad).
 */

export type GroupAdminPermission =
  | "can_restrict_members"
  | "can_delete_messages"
  | "can_change_info";

export interface GroupMembership {
  status: string;
  permissions?: Partial<Record<GroupAdminPermission, boolean>>;
}

/**
 * Permiso mínimo exigido por acción. No se usa "es administrador" a secas:
 * un administrador sin `can_restrict_members` no puede reencolar un mute.
 */
export const SECURITY_COMMAND_PERMISSIONS: Readonly<
  Record<SecurityAction, GroupAdminPermission>
> = {
  DELETE_MESSAGE: "can_delete_messages",
  MUTE_USER: "can_restrict_members",
  UNMUTE_USER: "can_restrict_members",
  BAN_USER: "can_restrict_members",
  UNBAN_USER: "can_restrict_members",
  KICK_USER: "can_restrict_members",
  UPDATE_SECURITY_CONFIG: "can_change_info",
  UPDATE_PROTECTED_USER: "can_restrict_members",
  WARN_USER: "can_restrict_members",
  UNWARN_USER: "can_restrict_members",
  UNWARN_ALL: "can_restrict_members",
  CLEAN_MESSAGES: "can_delete_messages",
};

function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

/** `true` sólo para creador y administradores del grupo. */
export function hasGroupAdministrativeStatus(
  membership: GroupMembership | undefined,
): boolean {
  const status = normalizeStatus(membership?.status);
  return status === "creator" || status === "administrator";
}

/**
 * `true` cuando el operador puede gestionar esta acción en este grupo.
 * El creador conserva todos los permisos; para administradores se exige el
 * permiso explícito de la acción.
 */
export function hasSecurityCommandAuthority(
  membership: GroupMembership | undefined,
  action: SecurityAction,
): boolean {
  if (!membership) return false;
  const status = normalizeStatus(membership.status);
  if (status === "creator") return true;
  if (status !== "administrator") return false;
  return membership.permissions?.[SECURITY_COMMAND_PERMISSIONS[action]] === true;
}

/** Adapta un `ChatMember` de Telegram al subconjunto que usa la autorización. */
export function groupMembershipFromChatMember(
  member: ChatMember,
): GroupMembership {
  const status = normalizeStatus(member.status);
  if (member.status === "administrator") {
    return {
      status,
      permissions: {
        can_restrict_members: member.can_restrict_members === true,
        can_delete_messages: member.can_delete_messages === true,
        can_change_info: member.can_change_info === true,
      },
    };
  }
  return { status };
}

/**
 * Consulta la membresía real del operador en el grupo mediante la caché corta
 * de `member-cache` (mismo mecanismo que `checkUserAdminOf`). Devuelve
 * `undefined` si Telegram no responde: la autorización se deniega.
 */
export async function loadGroupMembership(
  api: MemberLookupApi,
  groupId: number,
  actorId: number,
): Promise<GroupMembership | undefined> {
  if (!Number.isSafeInteger(groupId) || groupId === 0) return undefined;
  if (!Number.isSafeInteger(actorId) || actorId <= 0) return undefined;
  const member = await getCachedChatMember(api, groupId, actorId);
  return member ? groupMembershipFromChatMember(member) : undefined;
}
