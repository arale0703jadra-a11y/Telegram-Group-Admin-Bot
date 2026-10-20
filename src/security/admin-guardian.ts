import { Composer } from "grammy";
import type { ChatMember, ChatMemberAdministrator } from "@grammyjs/types";
import { OWNER_ID } from "../config.js";
import { getMemberSafely } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { invalidateSecurityCaches } from "../utils/member-cache.js";
import { isGroupChat } from "../utils/permissions.js";
import type { MyContext } from "../types.js";

const PRIVILEGED_ADMIN_PERMISSIONS = [
  "can_manage_chat",
  "can_delete_messages",
  "can_manage_video_chats",
  "can_restrict_members",
  "can_promote_members",
  "can_change_info",
  "can_invite_users",
  "can_post_messages",
  "can_edit_messages",
  "can_pin_messages",
  "can_manage_topics",
] as const satisfies readonly (keyof ChatMemberAdministrator)[];
type AdminPermission = (typeof PRIVILEGED_ADMIN_PERMISSIONS)[number];

type AdminStatus = "creator" | "administrator" | string;

export interface AdminChangeAssessment {
  oldStatus: AdminStatus;
  newStatus: AdminStatus;
  actorId?: number;
  targetId: number;
  actorAuthorized: boolean;
  oldPermissions?: Partial<Record<AdminPermission, boolean>>;
  newPermissions?: Partial<Record<AdminPermission, boolean>>;
}

function hasAdminPermission(
  member: ChatMember,
  permission: AdminPermission,
): boolean {
  return member.status === "administrator" && member[permission] === true;
}

export function assessAdminChange(change: AdminChangeAssessment): {
  promoted: boolean;
  permissionsChanged: boolean;
  privilegeEscalated: boolean;
  suspicious: boolean;
} {
  const promoted =
    change.newStatus === "administrator" &&
    change.oldStatus !== "administrator" &&
    change.oldStatus !== "creator";
  const permissionsChanged =
    change.oldStatus === "administrator" &&
    change.newStatus === "administrator" &&
    PRIVILEGED_ADMIN_PERMISSIONS.some(
      (permission) =>
        change.oldPermissions?.[permission] !==
        change.newPermissions?.[permission],
    );
  const privilegeEscalated = PRIVILEGED_ADMIN_PERMISSIONS.some(
    (permission) =>
      change.oldPermissions?.[permission] !== true &&
      change.newPermissions?.[permission] === true,
  );
  const selfPromotion = change.actorId === change.targetId;
  const suspicious =
    ((promoted || permissionsChanged) && !change.actorAuthorized) ||
    (permissionsChanged && privilegeEscalated) ||
    (promoted && selfPromotion);
  return { promoted, permissionsChanged, privilegeEscalated, suspicious };
}

function actorDisplay(ctx: MyContext): string {
  if (!ctx.from) return "no identificado";
  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");
  return `${name || "Usuario"} (ID ${ctx.from.id})`;
}

function targetDisplay(ctx: MyContext): string {
  const target = ctx.chatMember?.new_chat_member.user;
  if (!target) return "no identificado";
  const name = [target.first_name, target.last_name]
    .filter(Boolean)
    .join(" ");
  return `${name || "Usuario"}${target.username ? ` (@${target.username})` : ""} (ID ${target.id})`;
}

export const adminGuardian = new Composer<MyContext>();

adminGuardian.on("chat_member", async (ctx, next) => {
  if (!isGroupChat(ctx) || !ctx.chatMember) {
    await next();
    return;
  }

  const update = ctx.chatMember;
  const target = update.new_chat_member;
  const previous = update.old_chat_member;
  const oldStatus = previous.status;
  const newStatus = target.status;
  const roleOrPermissionsChanged =
    newStatus === "administrator" &&
    (oldStatus !== "administrator" ||
      PRIVILEGED_ADMIN_PERMISSIONS.some((permission) => {
        const oldValue = hasAdminPermission(previous, permission);
        const newValue = hasAdminPermission(target, permission);
        return oldStatus === "administrator" && oldValue !== newValue;
      }));

  if (!roleOrPermissionsChanged) {
    await next();
    return;
  }

  const actorId = ctx.from?.id;
  let actorAuthorized =
    typeof OWNER_ID === "number" && actorId === OWNER_ID;
  if (actorId !== undefined && actorId !== target.user.id) {
    invalidateSecurityCaches(ctx.chat.id, actorId);
    const actor = await getMemberSafely(ctx, ctx.chat.id, actorId);
    actorAuthorized ||= actor?.status === "creator" ||
      (actor?.status === "administrator" &&
        "can_promote_members" in actor &&
        actor.can_promote_members);
  }

  const oldPermissions: Partial<Record<AdminPermission, boolean>> = {};
  const newPermissions: Partial<Record<AdminPermission, boolean>> = {};
  for (const permission of PRIVILEGED_ADMIN_PERMISSIONS) {
    oldPermissions[permission] = hasAdminPermission(previous, permission);
    newPermissions[permission] = hasAdminPermission(target, permission);
  }

  const assessment = assessAdminChange({
    oldStatus,
    newStatus,
    actorId,
    targetId: target.user.id,
    actorAuthorized,
    oldPermissions,
    newPermissions,
  });

  if (assessment.suspicious) {
    const reason = !actorAuthorized
      ? "Actor no confirmado como propietario o administrador con permiso para promover."
      : assessment.privilegeEscalated
        ? "Se concedieron permisos administrativos adicionales."
        : "El usuario se promovió a sí mismo.";
    await logEvent(ctx, ctx.chat.id, "ADMIN_GUARDIAN", {
      targetId: target.user.id,
      targetName: target.user.username ?? target.user.first_name,
      result: "queued",
      detail:
        `${assessment.promoted ? "Promoción administrativa" : "Cambio de permisos"} detectado; ` +
        `actorId=${actorId ?? "unknown"}; ${reason}`,
    });

    const ownerId = OWNER_ID;
    if (
      typeof ownerId !== "number" ||
      !Number.isSafeInteger(ownerId) ||
      ownerId <= 0
    ) {
      console.error("[ADMIN_GUARDIAN] OWNER_ID no está configurado; alerta privada omitida.");
    } else {
      const action = assessment.promoted
        ? "Nuevo administrador detectado"
        : "Cambio sospechoso de permisos administrativos";
      try {
        await ctx.api.sendMessage(
          ownerId,
          `🛡️ ZEUS — ${action}\n` +
            `Grupo: ${ctx.chat.title ?? ctx.chat.id} (ID ${ctx.chat.id})\n` +
            `Objetivo: ${targetDisplay(ctx)}\n` +
            `Actor: ${actorDisplay(ctx)}\n` +
            `Motivo: ${reason}\n` +
            "Revisa manualmente el cambio en Telegram; ZEUS no revoca administradores automáticamente.",
        );
      } catch (error) {
        console.error(
          `[ADMIN_GUARDIAN] No se pudo notificar al propietario por privado (groupId=${ctx.chat.id}):`,
          error,
        );
      }
    }
  }

  await next();
});
