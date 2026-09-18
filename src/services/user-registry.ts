import type { ChatMember } from "@grammyjs/types";
import { getGroupData, saveGroupData } from "../storage/index.js";

export function memberStatus(member: ChatMember | undefined): IndexedUserStatus {
  return member?.status ?? "unknown";
}

export type IndexedUserStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked"
  | "unknown";

export async function recordObservedUser(
  groupId: number,
  user: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  },
  options: {
    joinedAt?: number;
    status?: IndexedUserStatus;
    message?: boolean;
    activity?: boolean;
  } = {},
): Promise<void> {
  const data = await getGroupData(groupId);
  const now = Math.floor(Date.now() / 1000);
  const key = String(user.id);
  const current = data.indexedUsers[key];
  const firstName = user.first_name ?? current?.firstName;
  const lastName = user.last_name ?? current?.lastName;
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  data.indexedUsers[key] = {
    ...current,
    id: user.id,
    groupId,
    firstName,
    lastName,
    name: displayName || current?.name,
    displayName: displayName || current?.displayName,
    username: user.username ?? current?.username ?? "",
    firstSeen: current?.firstSeen ?? now,
    joinedAt: options.joinedAt ?? current?.joinedAt,
    lastSeen: options.activity || options.message ? now : current?.lastSeen,
    lastActivityType: options.message
      ? "message"
      : options.activity
        ? "other"
        : current?.lastActivityType ?? "join",
    messageCount: (current?.messageCount ?? 0) + (options.message ? 1 : 0),
    status: options.status ?? current?.status ?? "unknown",
    zeusRole:
      options.status === "creator"
        ? "owner"
        : options.status === "administrator"
          ? "administrator"
          : current?.zeusRole ?? "user",
    verified: current?.verified ?? false,
  };
  await saveGroupData(groupId, data);
}

export async function markUserVerified(
  groupId: number,
  userId: number,
  username?: string,
  displayName?: string,
): Promise<void> {
  const data = await getGroupData(groupId);
  const current = data.indexedUsers[String(userId)];
  data.indexedUsers[String(userId)] = {
    ...current,
    id: userId,
    groupId,
    username: username ?? current?.username ?? "",
    name: displayName ?? current?.name,
    displayName: displayName ?? current?.displayName,
    firstSeen: current?.firstSeen ?? Math.floor(Date.now() / 1000),
    zeusRole: "verified",
    verified: true,
  };
  await saveGroupData(groupId, data);
}

export async function unmarkUserVerified(
  groupId: number,
  userId: number,
): Promise<void> {
  const data = await getGroupData(groupId);
  const current = data.indexedUsers[String(userId)];
  if (!current) return;
  data.indexedUsers[String(userId)] = {
    ...current,
    verified: false,
    zeusRole:
      current.status === "creator"
        ? "owner"
        : current.status === "administrator"
          ? "administrator"
          : current.zeusRole === "owner" || current.zeusRole === "administrator"
            ? current.zeusRole
            : "user",
  };
  await saveGroupData(groupId, data);
}
