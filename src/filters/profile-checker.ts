import { LINK_WHITELIST, PROFILE_BLOCKED_TERMS } from "../config.js";
import { Composer } from "grammy";
import { banUser, getMemberSafely, isVerifiableMember } from "../moderation/actions.js";
import { logEvent } from "../moderation/events.js";
import { KeyedMutex } from "../utils/safety.js";
import { inspectLinks } from "./link-filter.js";
import { isGroupChat } from "../utils/permissions.js";
import { sanitizeIncomingText } from "../utils/sanitizer.js";
import type { MyContext } from "../types.js";

export interface ProfileFields {
  firstName?: string;
  lastName?: string;
  username?: string;
}

const mutex = new KeyedMutex();
const recentlyChecked = new Map<string, number>();
const CHECK_DEDUPE_MS = 30_000;
const MAX_RECENTLY_CHECKED = 4096;
const PROFILE_HOMOGLYPHS: Readonly<Record<string, string>> = {
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
  ӏ: "l",
};

function normalizeProfileText(value: string): string {
  return sanitizeIncomingText(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\S]/gu, (character) => PROFILE_HOMOGLYPHS[character] ?? character)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function hasConfiguredTerm(text: string, term: string): boolean {
  const normalizedText = normalizeProfileText(text);
  const normalizedTerm = normalizeProfileText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }
  const words = normalizedTerm
    .split(" ")
    .map((word) =>
      [...word]
        .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "+")
        .join("[\\p{P}\\p{Z}\\s]*"),
    );
  const pattern = words.join("[\\p{P}\\p{Z}\\s]+");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(normalizedText);
}

export function inspectProfile(
  profile: ProfileFields,
  blockedTerms: readonly string[] = PROFILE_BLOCKED_TERMS,
  whitelist: readonly string[] = LINK_WHITELIST,
): string | undefined {
  const fields = [profile.firstName, profile.lastName, profile.username].filter(
    (value): value is string => Boolean(value),
  );
  const text = fields.join(" ");
  const linkResult = inspectLinks(text, [], {
    blockMentions: true,
    whitelist,
  });
  if (linkResult.hasUnauthorizedLink || linkResult.blockedMention) {
    return "profile-link";
  }

  const matchedTerm = blockedTerms.find((term) =>
    hasConfiguredTerm(text, term),
  );
  return matchedTerm ? `profile-term:${normalizeProfileText(matchedTerm)}` : undefined;
}

function rememberChecked(key: string, now: number): boolean {
  for (const [existingKey, checkedAt] of recentlyChecked) {
    if (now - checkedAt >= CHECK_DEDUPE_MS) {
      recentlyChecked.delete(existingKey);
    }
  }
  const previous = recentlyChecked.get(key);
  if (previous !== undefined && now - previous < CHECK_DEDUPE_MS) {
    return false;
  }
  recentlyChecked.set(key, now);
  if (recentlyChecked.size > MAX_RECENTLY_CHECKED) {
    const oldestKey = recentlyChecked.keys().next().value;
    if (oldestKey !== undefined) {
      recentlyChecked.delete(oldestKey);
    }
  }
  return true;
}

async function inspectJoinedMember(
  ctx: MyContext,
  user: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string },
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (
    !isGroupChat(ctx) ||
    typeof chatId !== "number" ||
    user.is_bot ||
    !Number.isSafeInteger(user.id)
  ) {
    return;
  }
  const key = `${chatId}:${user.id}`;
  const now = Date.now();

  await mutex.runExclusive(key, async () => {
    if (!rememberChecked(key, now)) {
      return;
    }
    const reason = inspectProfile({
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
    });
    if (!reason) {
      return;
    }

    const member = await getMemberSafely(ctx, chatId, user.id);
    if (!member || !isVerifiableMember(member) || member.user.is_bot) {
      recentlyChecked.delete(key);
      return;
    }

    const result = await banUser(
      ctx,
      chatId,
      user.id,
      user.username ?? user.first_name,
    );
    await logEvent(ctx, chatId, "BAN", {
      targetId: user.id,
      targetName: user.username ?? user.first_name,
      result: result.ok ? "ok" : "error",
      detail: `PROFILE_CHECK:${reason};permanentBan=${result.ok}`,
    });
  });
}

export const profileChecker = new Composer<MyContext>();

profileChecker.on("message:new_chat_members", async (ctx, next) => {
  for (const user of ctx.message.new_chat_members) {
    await inspectJoinedMember(ctx, user);
  }
  await next();
});

profileChecker.on("chat_member", async (ctx, next) => {
  const update = ctx.chatMember;
  const oldStatus = update.old_chat_member.status;
  const newMember = update.new_chat_member;
  if (
    (oldStatus === "left" || oldStatus === "kicked") &&
    (newMember.status === "member" || newMember.status === "restricted")
  ) {
    await inspectJoinedMember(ctx, newMember.user);
  }
  await next();
});
