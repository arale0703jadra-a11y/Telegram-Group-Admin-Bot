import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../types.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import { isProtectedMember, getMemberSafely } from "../moderation/actions.js";

export interface ResolvedUser {
  id: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  username?: string;
  lastSeen?: number;
}

export interface UserCardData {
  groupId: number;
  groupTitle?: string;
  user: ResolvedUser;
  member?: ChatMember;
  warnings: number;
  warnLimit: number;
  muted: boolean;
  mutedUntil?: number;
  banned: boolean;
  canMute: boolean;
  canBan: boolean;
  isProtected: boolean;
  lastSeen?: number;
}

/**
 * Resuelve un ID o un username exacto usando las capacidades reales del bot.
 */
export async function resolveUserTrigger(
  ctx: MyContext,
  chatId: number,
  trigger: string,
): Promise<ResolvedUser | undefined> {
  const users = await searchObservedUsers(ctx, chatId, trigger);
  return users.length === 1 ? users[0] : undefined;
}

export async function searchObservedUsers(
  ctx: MyContext,
  chatId: number,
  query: string,
): Promise<ResolvedUser[]> {
  const text = query.trim();
  if (!text) {
    return [];
  }

  if (/^-?\d+$/.test(text)) {
    const id = Number(text);
    const data = await getGroupData(chatId);
    const tracked = data.indexedUsers[String(id)];
    if (tracked) {
      return [toResolvedUser(tracked)];
    }
    const member = await getMemberSafely(ctx, chatId, id);
    if (!member) {
      return [];
    }
    const now = Math.floor(Date.now() / 1000);
    const firstName = member.user.first_name;
    const lastName = member.user.last_name;
    const displayName = [firstName, lastName].filter(Boolean).join(" ");
    data.indexedUsers[String(id)] = {
      id,
      groupId: chatId,
      firstName,
      lastName,
      name: displayName,
      displayName,
      username: member.user.username ?? "",
      firstSeen: now,
      lastSeen: now,
    };
    await saveGroupData(chatId, data);
    return [{
      id,
      firstName,
      lastName,
      name: displayName,
      username: member.user.username,
    }];
  }

  const normalized = text.replace(/^@/, "").toLocaleLowerCase();
  const data = await getGroupData(chatId);
  return Object.values(data.indexedUsers)
    .filter((tracked) => {
      const values = [
        tracked.username,
        tracked.name,
        tracked.displayName,
        tracked.firstName,
        tracked.lastName,
      ]
        .filter(Boolean)
        .map((value) => value!.toLocaleLowerCase());
      return values.some((value) => value.includes(normalized));
    })
    .map(toResolvedUser);
}

function toResolvedUser(user: {
  id: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  username?: string;
  lastSeen?: number;
}): ResolvedUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    name: user.name,
    username: user.username,
    lastSeen: user.lastSeen,
  };
}

/**
 * Devuelve un usuario si ya está indexado (escribió algún mensaje),
 * o un identificador de respaldo si no está indexado.
 */
export function getTrackedUser(
  data: { indexedUsers: Record<string, { id: number; firstName?: string; lastName?: string; name?: string; username?: string; lastSeen?: number }> },
  userId: number,
): ResolvedUser {
  const tracked = data.indexedUsers[String(userId)];
  return tracked
    ? toResolvedUser(tracked)
    : { id: userId, name: undefined, username: undefined, lastSeen: undefined };
}

/**
 * Reúne la información para pintar la ficha de usuario:
 * estado real del miembro + advertencias + estado de silencio.
 */
export async function getUserCard(
  ctx: MyContext,
  chatId: number,
  userId: number,
  groupTitle?: string,
): Promise<UserCardData> {
  const data = await getGroupData(chatId);
  const user = getTrackedUser(data, userId);
  const member = await getMemberSafely(ctx, chatId, userId);
  const mute = data.mutedUsers[String(userId)];
  const bannedRecord = data.bannedUsers[String(userId)];
  if (member) {
    user.firstName = member.user.first_name;
    user.lastName = member.user.last_name;
    user.name = member.user.first_name;
    user.name = [member.user.first_name, member.user.last_name]
      .filter(Boolean)
      .join(" ");
    user.username = member.user.username;
  }
  const now = Math.floor(Date.now() / 1000);
  const muted =
    member?.status === "restricted" &&
    (member.until_date === 0 || member.until_date > now);
  const banned = member
    ? member.status === "kicked"
    : bannedRecord !== undefined;

  return {
    groupId: chatId,
    groupTitle,
    user,
    member,
    warnings: (data.warnings[String(userId)] ?? []).length,
    warnLimit: data.warnLimit,
    muted,
    mutedUntil:
      muted && member?.status === "restricted" && member.until_date > 0
        ? member.until_date
        : muted
          ? mute?.until
          : undefined,
    banned,
    canMute: !member || member.status === "member" || member.status === "restricted",
    canBan: !banned && (!member || member.status === "member" || member.status === "restricted"),
    isProtected: member ? isProtectedMember(member) : false,
    lastSeen: user.lastSeen,
  };
}

/**
 * Formatea el texto "⚠️ Advertencias actuales" de un usuario.
 */
export function buildWarningsText(
  user: ResolvedUser,
  warnings: number,
  warnLimit: number,
): string {
  const who = user.username ? `@${user.username}` : user.name ?? `ID ${user.id}`;
  return (
    `⚠️ *ADVERTENCIAS*\n\n` +
    `Usuario: ${who}\n` +
    `Advertencias actuales: *${warnings}/${warnLimit}*\n\n` +
    `📋 La acción automática al superar el límite aún no está configurada.`
  );
}