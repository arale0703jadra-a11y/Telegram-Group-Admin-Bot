import type { ChatMember, User } from "@grammyjs/types";
import { Composer } from "grammy";
import { OWNER_ID } from "../config.js";
import {
  banUser,
  getMemberSafely,
  isVerifiableMember,
} from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { isGroupChat } from "../utils/permissions.js";
import { KeyedMutex } from "../utils/safety.js";
import type { MyContext } from "../types.js";

export interface AdminIdentity {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface ImpersonationProfile extends AdminIdentity {}

export type ImpersonationMatch =
  | { kind: "username-exact"; adminId: number }
  | { kind: "username-near"; adminId: number }
  | { kind: "name-exact"; adminId: number }
  | { kind: "name-near"; adminId: number };

const ADMIN_CACHE_TTL_MS = 30_000;
const MAX_ADMIN_CACHE_ENTRIES = 2048;
const CHECK_COOLDOWN_MS = 10_000;
const MAX_CHECK_ENTRIES = 8192;
const adminCache = new Map<number, { expiresAt: number; admins: AdminIdentity[] }>();
const checkedUsers = new Map<
  string,
  { checkedAt: number; profileFingerprint: string }
>();
const mutex = new KeyedMutex();

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
};

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\S]/gu, (character) => HOMOGLYPHS[character] ?? character)
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedDisplayName(profile: AdminIdentity): string {
  return [profile.firstName, profile.lastName]
    .map(normalizeIdentity)
    .filter(Boolean)
    .join("");
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }
  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) {
      return false;
    }
    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) {
    differences += 1;
  }
  return differences <= 1;
}

function hasTwoNameParts(profile: AdminIdentity): boolean {
  return Boolean(normalizeIdentity(profile.firstName) && normalizeIdentity(profile.lastName));
}

export function detectAdminImpersonation(
  profile: ImpersonationProfile,
  admins: readonly AdminIdentity[],
): ImpersonationMatch | undefined {
  const username = normalizeIdentity(profile.username);
  const displayName = normalizedDisplayName(profile);
  const fullNameCanBeCompared = hasTwoNameParts(profile);

  for (const admin of admins) {
    if (admin.id === profile.id) {
      continue;
    }
    const adminUsername = normalizeIdentity(admin.username);
    if (username && adminUsername && username === adminUsername) {
      return { kind: "username-exact", adminId: admin.id };
    }
  }

  for (const admin of admins) {
    if (admin.id === profile.id) {
      continue;
    }
    const adminUsername = normalizeIdentity(admin.username);
    if (
      username.length >= 7 &&
      adminUsername.length >= 7 &&
      editDistanceAtMostOne(username, adminUsername)
    ) {
      return { kind: "username-near", adminId: admin.id };
    }
  }

  for (const admin of admins) {
    if (admin.id === profile.id || !fullNameCanBeCompared || !hasTwoNameParts(admin)) {
      continue;
    }
    const adminName = normalizedDisplayName(admin);
    if (displayName.length >= 8 && displayName === adminName) {
      return { kind: "name-exact", adminId: admin.id };
    }
  }

  for (const admin of admins) {
    if (admin.id === profile.id || !fullNameCanBeCompared || !hasTwoNameParts(admin)) {
      continue;
    }
    const adminName = normalizedDisplayName(admin);
    if (
      displayName.length >= 10 &&
      adminName.length >= 10 &&
      editDistanceAtMostOne(displayName, adminName)
    ) {
      return { kind: "name-near", adminId: admin.id };
    }
  }

  return undefined;
}

function toIdentity(user: User): AdminIdentity {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
  };
}

function isAdminMember(member: ChatMember): boolean {
  return member.status === "creator" || member.status === "administrator";
}

async function getAdminIdentities(
  ctx: MyContext,
  chatId: number,
): Promise<AdminIdentity[] | undefined> {
  const now = Date.now();
  const cached = adminCache.get(chatId);
  if (cached && cached.expiresAt > now) {
    return cached.admins;
  }

  try {
    const members = await ctx.api.getChatAdministrators(chatId);
    const admins = members
      .filter(isAdminMember)
      .map((member) => toIdentity(member.user));
    adminCache.delete(chatId);
    adminCache.set(chatId, { admins, expiresAt: now + ADMIN_CACHE_TTL_MS });
    while (adminCache.size > MAX_ADMIN_CACHE_ENTRIES) {
      const oldestChatId = adminCache.keys().next().value;
      if (oldestChatId === undefined) break;
      adminCache.delete(oldestChatId);
    }
    return admins;
  } catch (error) {
    console.error(
      `[ADMIN IMPERSONATION] No se pudieron consultar los administradores (chatId=${chatId}, error=${error instanceof Error ? error.name : "unknown"}).`,
    );
    return undefined;
  }
}

function profileFingerprint(profile: ImpersonationProfile): string {
  return [
    normalizeIdentity(profile.firstName),
    normalizeIdentity(profile.lastName),
    normalizeIdentity(profile.username),
  ].join(":");
}

function shouldCheckUser(
  key: string,
  profile: ImpersonationProfile,
  now: number,
): boolean {
  for (const [existingKey, check] of checkedUsers) {
    if (now - check.checkedAt >= CHECK_COOLDOWN_MS) {
      checkedUsers.delete(existingKey);
    }
  }
  const fingerprint = profileFingerprint(profile);
  const previous = checkedUsers.get(key);
  if (
    previous?.profileFingerprint === fingerprint &&
    now - previous.checkedAt < CHECK_COOLDOWN_MS
  ) {
    return false;
  }
  checkedUsers.set(key, { checkedAt: now, profileFingerprint: fingerprint });
  if (checkedUsers.size > MAX_CHECK_ENTRIES) {
    const oldestKey = checkedUsers.keys().next().value;
    if (oldestKey !== undefined) checkedUsers.delete(oldestKey);
  }
  return true;
}

async function inspectUser(
  ctx: MyContext,
  profile: ImpersonationProfile,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (
    !isGroupChat(ctx) ||
    typeof chatId !== "number" ||
    !Number.isSafeInteger(profile.id) ||
    profile.id === OWNER_ID
  ) {
    return;
  }

  const key = `${chatId}:${profile.id}`;
  await mutex.runExclusive(key, async () => {
    if (!shouldCheckUser(key, profile, Date.now())) {
      return;
    }

    const member = await getMemberSafely(ctx, chatId, profile.id);
    if (!member || member.user.is_bot || !isVerifiableMember(member)) {
      checkedUsers.delete(key);
      return;
    }

    const admins = await getAdminIdentities(ctx, chatId);
    if (!admins) {
      checkedUsers.delete(key);
      return;
    }

    const match = detectAdminImpersonation(profile, admins);
    if (!match) {
      return;
    }

    const result = await banUser(
      ctx,
      chatId,
      profile.id,
      profile.username ?? [profile.firstName, profile.lastName].filter(Boolean).join(" "),
    );
    await logEvent(ctx, chatId, "BAN", {
      targetId: profile.id,
      targetName: profile.username ?? profile.firstName,
      result: result.ok ? "ok" : "error",
      detail:
        `ADMIN_IMPERSONATION:${match.kind};adminId=${match.adminId};` +
        `permanentBan=${result.ok}`,
    });
  });
}

export const adminImpersonation = new Composer<MyContext>();

adminImpersonation.on("message", async (ctx, next) => {
  if (
    !ctx.from ||
    ctx.from.is_bot ||
    ctx.from.id === ctx.me.id ||
    (ctx.message && "new_chat_members" in ctx.message)
  ) {
    await next();
    return;
  }

  await inspectUser(ctx, toIdentity(ctx.from));
  await next();
});

adminImpersonation.on("chat_member", async (ctx, next) => {
  await inspectUser(ctx, toIdentity(ctx.chatMember.new_chat_member.user));
  await next();
});
