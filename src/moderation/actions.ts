import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../types.js";
import { isConfiguredAdminId } from "../config.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import { callWithRetryAfter, runChatActionExclusive } from "../utils/safety.js";
import {
  getCachedBotRights,
  getCachedChatMember,
  invalidateSecurityCaches,
} from "../utils/member-cache.js";
import { getSystemOwnerId } from "../services/system-owner.js";
import { logEvent } from "./events.js";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface CleanResult {
  attempted: number;
  deleted: number;
  failed: number;
}

function reasonDetail(reason?: string): string {
  return reason ? `; Motivo: ${reason.slice(0, 240)}` : "";
}

export const PERMISSION_ERROR =
  "El bot necesita ser administrador con permisos de restricción (⛔ can_restrict_members) en el grupo.";

const MUTE_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: false,
};

const DEFAULT_MEMBER_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_react_to_messages: true,
  can_change_info: false,
  can_invite_users: false,
  can_edit_tag: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

const PERMISSION_SNAPSHOT_KEYS: readonly (keyof ChatPermissions)[] = [
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
  "can_send_polls",
  "can_send_other_messages",
  "can_add_web_page_previews",
  "can_react_to_messages",
  "can_change_info",
  "can_invite_users",
  "can_edit_tag",
  "can_pin_messages",
  "can_manage_topics",
];

function isValidPermissionSnapshot(value: unknown): value is ChatPermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return PERMISSION_SNAPSHOT_KEYS.every(
    (key) => typeof snapshot[key] === "boolean",
  );
}

export interface BotRights {
  canRestrict: boolean;
  canDelete: boolean;
}

/**
 * Consulta los permisos del propio bot dentro del grupo.
 * Usa caché con caducidad (60 s) y cooldown ante 429 (ver utils/member-cache).
 * Sin respuesta verificable se deniegan los permisos; nunca se conceden
 * permisos por defecto.
 */
export async function getBotRights(
  ctx: MyContext,
  chatId: number,
): Promise<BotRights> {
  return getCachedBotRights(ctx.api, chatId, ctx.me.id);
}

/**
 * Obtiene el miembro objetivo de forma segura (no lanza).
 * Usa caché corta (10 s) y cooldown ante 429 para que una oleada de spam no
 * convierta cada mensaje en una llamada a la API. Devuelve `undefined` cuando
 * no hay respuesta verificable: los filtros deben OMITIR la sanción en ese
 * caso (nunca sancionar sin verificar).
 */
export async function getMemberSafely(
  ctx: MyContext,
  chatId: number,
  userId: number,
): Promise<ChatMember | undefined> {
  return getCachedChatMember(ctx.api, chatId, userId);
}

export async function isProtectedModerationTarget(
  ctx: MyContext,
  chatId: number,
  userId: number,
  ownerLookup: () => Promise<number | undefined> = getSystemOwnerId,
): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || ctx.from?.id === userId) {
    return true;
  }
  invalidateSecurityCaches(chatId, userId);
  const member = await getMemberSafely(ctx, chatId, userId);
  if (member && isProtectedMember(member)) return true;
  try {
    const ownerId = await ownerLookup();
    return userId === ownerId || isConfiguredAdminId(userId);
  } catch (error) {
    console.error(
      `[MODERATION] No se pudo comprobar el propietario groupId=${chatId} ` +
        `targetId=${userId} error=${error instanceof Error ? error.name : "unknown"}; acción denegada`,
    );
    return true;
  }
}

/**
 * Impide sancionar al propietario o a un administrador.
 */
export function isProtectedMember(member: ChatMember): boolean {
  return member.status === "creator" || member.status === "administrator";
}

/**
 * Solo estos estados confirman que el objetivo sigue siendo un miembro
 * normal verificable del grupo.
 */
export function isVerifiableMember(member: ChatMember): boolean {
  return member.status === "member" || member.status === "restricted";
}

function isEpochNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const AUTOMATIC_MUTE_MINUTES = 1440;

/**
 * Añade una advertencia al usuario.
 */
export async function warnUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
  reason?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  const member = await getMemberSafely(ctx, chatId, userId);
  if (
    !member ||
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isConfiguredAdminId(userId) ||
    isProtectedMember(member)
  ) {
    return {
      ok: false,
      error: "No se puede advertir a un usuario no verificable o protegido.",
    };
  }
  try {
    const data = await getGroupData(chatId);
    const key = String(userId);
    const entries = data.warnings[key] ?? [];
    entries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      adminId: ctx.from?.id ?? 0,
      adminName: ctx.from?.first_name ?? "Desconocido",
      date: new Date().toISOString(),
      reason: reason?.trim() || undefined,
    });
    data.warnings[key] = entries;
    data.warnAction ??= "mute";
    await saveGroupData(chatId, data);

    if (entries.length >= data.warnLimit && data.warnAction !== "none") {
      const automaticResult =
        data.warnAction === "ban"
          ? await banUser(ctx, chatId, userId, name)
          : await muteUser(
              ctx,
              chatId,
              userId,
              AUTOMATIC_MUTE_MINUTES,
              name,
            );
      if (!automaticResult.ok) {
        console.error(
          `[WARN] No se pudo aplicar la acción automática: ${automaticResult.error}`,
        );
      }
    }

    await logEvent(ctx, chatId, "WARN", {
      targetId: userId,
      targetName: name,
      result: "ok",
      detail: `Advertencia ${entries.length}/${data.warnLimit}`,
    });
    return { ok: true };
  } catch (error) {
    console.error("[WARN] Error al guardar advertencia:", error);
    await logEvent(ctx, chatId, "WARN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "Error al guardar en almacenamiento",
    });
    return { ok: false, error: "No se pudo guardar la advertencia." };
  }
}

/**
 * Quita una advertencia al usuario (mínimo 0).
 */
export async function unwarnUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  try {
    const data = await getGroupData(chatId);
    const key = String(userId);
    const entries = data.warnings[key] ?? [];
    if (entries.length > 0) {
      entries.pop();
      if (entries.length === 0) {
        delete data.warnings[key];
      } else {
        data.warnings[key] = entries;
      }
    }
    await saveGroupData(chatId, data);

    await logEvent(ctx, chatId, "UNWARN", {
      targetId: userId,
      targetName: name,
      result: "ok",
      detail: `Advertencias restantes: ${entries.length}`,
    });
    return { ok: true };
  } catch (error) {
    console.error("[UNWARN] Error al quitar advertencia:", error);
    await logEvent(ctx, chatId, "UNWARN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "Error al guardar en almacenamiento",
    });
    return { ok: false, error: "No se pudo quitar la advertencia." };
  }
}

/**
 * Quita todas las advertencias de un usuario.
 */
export async function unwarnAllUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  try {
    const data = await getGroupData(chatId);
    const key = String(userId);
    const entries = data.warnings[key] ?? [];
    const count = entries.length;
    if (count > 0) {
      delete data.warnings[key];
      await saveGroupData(chatId, data);
    }

    await logEvent(ctx, chatId, "UNWARN", {
      targetId: userId,
      targetName: name,
      result: "ok",
      detail: `Eliminadas ${count} advertencias`,
    });
    return { ok: true };
  } catch (error) {
    console.error("[UNWARNALL] Error al quitar todas las advertencias:", error);
    await logEvent(ctx, chatId, "UNWARN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "Error al guardar en almacenamiento",
    });
    return { ok: false, error: "No se pudieron eliminar las advertencias." };
  }
}

/**
 * Silencia al usuario usando restrictChatMember con fecha de fin.
 * Al terminar el período, Telegram restaura los permisos automáticamente.
 */
export async function muteUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  minutes: number,
  targetName?: string,
  reason?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 527040) {
    await logEvent(ctx, chatId, "MUTE", {
      targetId: userId,
      targetName: name,
      result: "rejected",
      detail: `Duración inválida${reasonDetail(reason)}`,
    });
    return { ok: false, error: "La duración debe estar entre 1 y 527040 minutos." };
  }
  const { canRestrict } = await getBotRights(ctx, chatId);
  if (!canRestrict) {
    await logEvent(ctx, chatId, "MUTE", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `Sin permisos del bot${reasonDetail(reason)}`,
    });
    return { ok: false, error: PERMISSION_ERROR };
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member) {
    await logEvent(ctx, chatId, "MUTE", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `No se pudo verificar el estado del usuario${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No encuentro al usuario en el grupo." };
  }
  if (
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isConfiguredAdminId(userId) ||
    isProtectedMember(member)
  ) {
    await logEvent(ctx, chatId, "MUTE", {
      targetId: userId,
      targetName: name,
      result: "rejected",
      detail: `Objetivo protegido o no sancionable${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No se puede silenciar a un administrador o al propietario." };
  }

  let hasActiveMuteRecord = false;
  let previousPermissions: ChatPermissions | undefined;
  try {
    const data = await getGroupData(chatId);
    const previousMute = data.mutedUsers[String(userId)];
    if (previousMute && previousMute.until > isEpochNowSeconds()) {
      hasActiveMuteRecord = true;
      if (isValidPermissionSnapshot(previousMute.previousPermissions)) {
        previousPermissions = previousMute.previousPermissions;
      }
    }
  } catch (error) {
    console.error(
      `[MODERATION] No se pudo leer el snapshot previo groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  const until = isEpochNowSeconds() + minutes * 60;
  try {
    await callWithRetryAfter(() =>
      ctx.api.restrictChatMember(chatId, userId, MUTE_PERMISSIONS, {
        until_date: until,
      }),
    );
  } catch {
    await logEvent(ctx, chatId, "MUTE", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `Telegram rechazó el silencio${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No se pudo silenciar al usuario." };
  }

  try {
    const data = await getGroupData(chatId);
    data.mutedUsers[String(userId)] = {
      until,
      adminId: ctx.from?.id,
      adminName: ctx.from?.first_name,
      at: new Date().toISOString(),
      previousPermissions: hasActiveMuteRecord
        ? previousPermissions
        : member.status === "restricted"
          ? {
              can_send_messages: member.can_send_messages,
              can_send_audios: member.can_send_audios,
              can_send_documents: member.can_send_documents,
              can_send_photos: member.can_send_photos,
              can_send_videos: member.can_send_videos,
              can_send_video_notes: member.can_send_video_notes,
              can_send_voice_notes: member.can_send_voice_notes,
              can_send_polls: member.can_send_polls,
              can_send_other_messages: member.can_send_other_messages,
              can_add_web_page_previews: member.can_add_web_page_previews,
              can_react_to_messages: member.can_react_to_messages,
              can_change_info: member.can_change_info,
              can_invite_users: member.can_invite_users,
              can_edit_tag: member.can_edit_tag,
              can_pin_messages: member.can_pin_messages,
              can_manage_topics: member.can_manage_topics,
            }
          : undefined,
    };
    await saveGroupData(chatId, data);
  } catch (error) {
    console.error(
      `[MODERATION] Silencio aplicado sin snapshot persistido groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  await logEvent(ctx, chatId, "MUTE", {
    targetId: userId,
    targetName: name,
    result: "ok",
    detail: `${minutes} min${reasonDetail(reason)}`,
  });
  return { ok: true };
}

/**
 * Restaura los permisos normales del usuario (quitar silencio).
 */
export async function unmuteUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  const { canRestrict } = await getBotRights(ctx, chatId);
  if (!canRestrict) {
    await logEvent(ctx, chatId, "UNMUTE", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "Sin permisos del bot",
    });
    return { ok: false, error: PERMISSION_ERROR };
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member) {
    await logEvent(ctx, chatId, "UNMUTE", {
      targetId: userId,
      targetName: name,
      result: "rejected",
      detail: "No se encontró un miembro que pueda desmutearse.",
    });
    return { ok: false, error: "No encuentro al usuario en el grupo." };
  }

  let permissions = DEFAULT_MEMBER_PERMISSIONS;
  try {
    const data = await getGroupData(chatId);
    const previous = data.mutedUsers[String(userId)]?.previousPermissions;
    if (isValidPermissionSnapshot(previous)) {
      permissions = previous;
    }
  } catch (error) {
    console.error(
      `[MODERATION] No se pudo leer el snapshot al desmutear groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}; se usarán permisos básicos`,
    );
  }

  try {
    await ctx.api.restrictChatMember(chatId, userId, permissions, {
      until_date: 0,
    });
  } catch {
    await logEvent(ctx, chatId, "UNMUTE", {
      targetId: userId,
      targetName: name,
      result: "error",
    });
    return { ok: false, error: "No se pudo quitar el silencio." };
  }

  try {
    const data = await getGroupData(chatId);
    delete data.mutedUsers[String(userId)];
    await saveGroupData(chatId, data);
  } catch (error) {
    console.error(
      `[MODERATION] Desmute aplicado sin actualizar el almacenamiento groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  await logEvent(ctx, chatId, "UNMUTE", {
    targetId: userId,
    targetName: name,
    result: "ok",
  });
  return { ok: true };
}

/**
 * Banea al usuario y lo recuerda en el almacén para poder desbanearlo.
 */
export async function banUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
  reason?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  const { canRestrict } = await getBotRights(ctx, chatId);
  if (!canRestrict) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `Sin permisos del bot${reasonDetail(reason)}`,
    });
    return { ok: false, error: PERMISSION_ERROR };
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `Autoban omitido: no se pudo verificar el estado actual del usuario.${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No se pudo verificar el estado del usuario." };
  }
  if (
    member.user.is_bot ||
    !isVerifiableMember(member) ||
    isConfiguredAdminId(userId) ||
    isProtectedMember(member)
  ) {
    await logEvent(ctx, chatId, "BAN", {
      targetId: userId,
      targetName: name,
      result: "rejected",
      detail: `Autoban omitido: propietario o administrador protegido.${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No se puede banear al propietario o a un administrador." };
  }

  try {
    await runChatActionExclusive(chatId, () =>
      callWithRetryAfter(() => ctx.api.banChatMember(chatId, userId)),
    );
  } catch (error) {
    const technicalError =
      error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 300) : "unknown";
    await logEvent(ctx, chatId, "BAN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: `Telegram rechazó el ban: ${technicalError}${reasonDetail(reason)}`,
    });
    return { ok: false, error: "No se pudo banear al usuario." };
  }

  try {
    const data = await getGroupData(chatId);
    data.bannedUsers[String(userId)] = {
      id: userId,
      name,
      at: new Date().toISOString(),
      adminId: ctx.from?.id,
      adminName: ctx.from?.first_name,
    };
    await saveGroupData(chatId, data);
  } catch (error) {
    console.error(
      `[MODERATION] Ban aplicado sin guardar el registro local groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  await logEvent(ctx, chatId, "BAN", {
    targetId: userId,
    targetName: name,
    result: "ok",
    detail: `Permanente${reasonDetail(reason)}`,
  });
  return { ok: true };
}

/**
 * Desbanea a un usuario y lo quita de la lista registrada.
 */
export async function unbanUser(
  ctx: MyContext,
  chatId: number,
  userId: number,
  targetName?: string,
): Promise<ActionResult> {
  const name = targetName ?? String(userId);
  const { canRestrict } = await getBotRights(ctx, chatId);
  if (!canRestrict) {
    await logEvent(ctx, chatId, "UNBAN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "Sin permisos del bot",
    });
    return { ok: false, error: PERMISSION_ERROR };
  }

  const member = await getMemberSafely(ctx, chatId, userId);
  if (!member) {
    await logEvent(ctx, chatId, "UNBAN", {
      targetId: userId,
      targetName: name,
      result: "error",
      detail: "No se pudo verificar el estado actual del usuario.",
    });
    return { ok: false, error: "No se pudo verificar el estado del usuario." };
  }
  if (member.status !== "kicked") {
    await logEvent(ctx, chatId, "UNBAN", {
      targetId: userId,
      targetName: name,
      result: "rejected",
      detail: "El usuario no está baneado.",
    });
    return { ok: false, error: "El usuario no está baneado." };
  }

  try {
    await ctx.api.unbanChatMember(chatId, userId, { only_if_banned: true });
  } catch {
    await logEvent(ctx, chatId, "UNBAN", {
      targetId: userId,
      targetName: name,
      result: "error",
    });
    return { ok: false, error: "No se pudo desbanear al usuario." };
  }

  try {
    const data = await getGroupData(chatId);
    delete data.bannedUsers[String(userId)];
    await saveGroupData(chatId, data);
  } catch (error) {
    console.error(
      `[MODERATION] Unban aplicado sin actualizar el almacenamiento groupId=${chatId} ` +
        `userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  await logEvent(ctx, chatId, "UNBAN", {
    targetId: userId,
    targetName: name,
    result: "ok",
  });
  return { ok: true };
}

/**
 * Elimina un mensaje concreto del grupo.
 * El registro del evento DELETE lo hace el llamador (tiene el contexto).
 */
export async function deleteMessageById(
  ctx: MyContext,
  chatId: number,
  messageId: number,
): Promise<ActionResult> {
  try {
    await runChatActionExclusive(chatId, () =>
      callWithRetryAfter(() => ctx.api.deleteMessage(chatId, messageId)),
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Permisos insuficientes o mensaje demasiado antiguo.",
    };
  }
}

/**
 * Borra hasta `count` de los últimos mensajes que el bot ha podido
 * localizar en el grupo. Cada fallo (mensaje ya borrado, antiguo, etc.)
 * se ignora de forma individual y solo se informa de lo realmente hecho.
 */
export async function cleanRecentMessages(
  ctx: MyContext,
  chatId: number,
  count: number,
): Promise<CleanResult> {
  const data = await getGroupData(chatId);
  const ids = data.recentMessages.slice(-count);
  if (ids.length === 0) {
    return { attempted: 0, deleted: 0, failed: 0 };
  }

  let deleted = 0;
  for (const messageId of ids) {
    const result = await deleteMessageById(ctx, chatId, messageId);
    if (result.ok) {
      deleted += 1;
    }
  }
  return {
    attempted: ids.length,
    deleted,
    failed: ids.length - deleted,
  };
}