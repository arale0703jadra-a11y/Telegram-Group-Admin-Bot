import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import {
  banUser,
  isProtectedModerationTarget,
  muteUser,
  unbanUser,
  unmuteUser,
} from "../src/moderation/actions.js";
import { flushStorage, getGroupData } from "../src/storage/index.js";
import { resetSecurityCaches } from "../src/utils/member-cache.js";

const BOT_ID = 900000001;
const USER_ID = 900000002;

test("manual moderation protects the dynamic owner and fails closed on lookup errors", async () => {
  const chatId = -Math.floor(Date.now()) - 9;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> => ({
      status: "member",
      user: { id: userId, is_bot: false, first_name: "Member" },
    } as ChatMember),
  };
  const ctx = {
    api,
    from: { id: 700, first_name: "Moderator" },
    me: { id: BOT_ID },
  } as unknown as MyContext;
  const originalError = console.error;
  console.error = () => {};
  try {
    resetSecurityCaches();
    assert.equal(
      await isProtectedModerationTarget(ctx, chatId, USER_ID, async () => USER_ID),
      true,
    );
    assert.equal(
      await isProtectedModerationTarget(ctx, chatId, USER_ID + 1, async () => {
        throw new Error("owner lookup unavailable");
      }),
      true,
    );
  } finally {
    console.error = originalError;
    resetSecurityCaches();
    await flushStorage();
  }
});

test("unmute without a valid permission snapshot grants only basic member permissions", async () => {
  const chatId = -Math.floor(Date.now());
  const storageFile = resolve(
    process.cwd(),
    "data",
    "storage",
    `${chatId}.json`,
  );
  const restoredPermissions: ChatPermissions[] = [];

  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
            can_delete_messages: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    restrictChatMember: async (
      _chatId: number | string,
      _userId: number,
      permissions: ChatPermissions,
    ): Promise<boolean> => {
      restoredPermissions.push(permissions);
      return true;
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
  } as unknown as MyContext;

  try {
    resetSecurityCaches();
    const result = await unmuteUser(ctx, chatId, USER_ID);

    assert.equal(result.ok, true);
    assert.equal(restoredPermissions.length, 1);
    const permissions = restoredPermissions[0];
    assert.ok(permissions);
    assert.equal(permissions.can_send_messages, true);
    assert.equal(permissions.can_send_photos, true);
    assert.equal(permissions.can_add_web_page_previews, true);
    assert.equal(permissions.can_change_info, false);
    assert.equal(permissions.can_invite_users, false);
    assert.equal(permissions.can_edit_tag, false);
    assert.equal(permissions.can_pin_messages, false);
    assert.equal(permissions.can_manage_topics, false);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("unban only_if_banned removes an existing ban without joining the user", async () => {
  const chatId = -Math.floor(Date.now()) - 1;
  const optionsSeen: Array<{ only_if_banned?: boolean }> = [];
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "kicked",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    unbanChatMember: async (
      _chatId: number | string,
      _userId: number,
      options: { only_if_banned?: boolean },
    ): Promise<boolean> => {
      optionsSeen.push(options);
      return true;
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
    from: { id: 700, first_name: "Moderator" },
  } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const result = await unbanUser(ctx, chatId, USER_ID);
    assert.equal(result.ok, true);
    assert.deepEqual(optionsSeen, [{ only_if_banned: true }]);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("unban does not report success or call Telegram for an unbanned member", async () => {
  const chatId = -Math.floor(Date.now()) - 2;
  let unbanCalls = 0;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    unbanChatMember: async (): Promise<boolean> => {
      unbanCalls++;
      return true;
    },
  };
  const ctx = { api, me: { id: BOT_ID } } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const result = await unbanUser(ctx, chatId, USER_ID);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no está baneado/u);
    assert.equal(unbanCalls, 0);
    const data = await getGroupData(chatId);
    assert.equal(data.events.at(-1)?.result, "rejected");
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("Telegram unban failure is not reported as success", async () => {
  const chatId = -Math.floor(Date.now()) - 8;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "kicked",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    unbanChatMember: async (): Promise<boolean> => {
      throw new Error("telegram rejected");
    },
  };
  const ctx = { api, me: { id: BOT_ID } } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const result = await unbanUser(ctx, chatId, USER_ID);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No se pudo desbanear/u);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("ban applies only to a verified ordinary member and records the reason", async () => {
  const chatId = -Math.floor(Date.now()) - 3;
  const banCalls: Array<[number | string, number]> = [];
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    banChatMember: async (targetChatId: number | string, userId: number): Promise<boolean> => {
      banCalls.push([targetChatId, userId]);
      return true;
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
    from: { id: 700, first_name: "Moderator" },
  } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const result = await banUser(ctx, chatId, USER_ID, "Member", "spam");
    assert.equal(result.ok, true);
    assert.deepEqual(banCalls, [[chatId, USER_ID]]);
    const data = await getGroupData(chatId);
    assert.match(data.events.at(-1)?.detail ?? "", /Motivo: spam/u);
    assert.equal(data.bannedUsers[String(USER_ID)]?.id, USER_ID);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("temporary mute validates its duration and records the configured reason", async () => {
  const chatId = -Math.floor(Date.now()) - 4;
  const restrictions: Array<{ permissions: ChatPermissions; until_date?: number }> = [];
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    restrictChatMember: async (
      _chatId: number | string,
      _userId: number,
      permissions: ChatPermissions,
      options: { until_date?: number },
    ): Promise<boolean> => {
      restrictions.push({ permissions, until_date: options.until_date });
      return true;
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
    from: { id: 700, first_name: "Moderator" },
  } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const invalid = await muteUser(ctx, chatId, USER_ID, 0, "Member");
    assert.equal(invalid.ok, false);
    assert.equal(restrictions.length, 0);

    const result = await muteUser(ctx, chatId, USER_ID, 30, "Member", "flood");
    assert.equal(result.ok, true);
    assert.equal(restrictions.length, 1);
    assert.ok((restrictions[0]?.until_date ?? 0) > Math.floor(Date.now() / 1000));
    const data = await getGroupData(chatId);
    assert.equal(data.events[0]?.result, "rejected");
    assert.equal(data.events.at(-1)?.result, "ok");
    assert.match(data.events.at(-1)?.detail ?? "", /30 min; Motivo: flood/u);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("Telegram ban rejection is reported as failure and never persisted as success", async () => {
  const chatId = -Math.floor(Date.now()) - 5;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    banChatMember: async (): Promise<boolean> => {
      throw new Error("telegram rejected");
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
    from: { id: 700, first_name: "Moderator" },
  } as unknown as MyContext;
  try {
    resetSecurityCaches();
    const result = await banUser(ctx, chatId, USER_ID, "Member");
    assert.equal(result.ok, false);
    const data = await getGroupData(chatId);
    assert.equal(data.bannedUsers[String(USER_ID)], undefined);
    assert.equal(data.events.at(-1)?.result, "error");
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("ban and mute fail closed when ZEUS lacks restriction rights", async () => {
  const chatId = -Math.floor(Date.now()) - 6;
  let actionCalls = 0;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: false,
          } as ChatMember)
        : ({
            status: "member",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
          } as ChatMember),
    banChatMember: async (): Promise<boolean> => {
      actionCalls++;
      return true;
    },
    restrictChatMember: async (): Promise<boolean> => {
      actionCalls++;
      return true;
    },
  };
  const ctx = { api, me: { id: BOT_ID } } as unknown as MyContext;
  try {
    resetSecurityCaches();
    assert.equal((await banUser(ctx, chatId, USER_ID)).ok, false);
    assert.equal((await muteUser(ctx, chatId, USER_ID, 30)).ok, false);
    assert.equal(actionCalls, 0);
    const data = await getGroupData(chatId);
    assert.deepEqual(data.events.map((event) => event.result), ["error", "error"]);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});

test("ban and mute protect Telegram administrators", async () => {
  const chatId = -Math.floor(Date.now()) - 7;
  let actionCalls = 0;
  const api = {
    getChatMember: async (
      _chatId: number | string,
      userId: number,
    ): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
          } as ChatMember)
        : ({
            status: "administrator",
            user: { id: USER_ID, is_bot: false, first_name: "Admin" },
          } as ChatMember),
    banChatMember: async (): Promise<boolean> => {
      actionCalls++;
      return true;
    },
    restrictChatMember: async (): Promise<boolean> => {
      actionCalls++;
      return true;
    },
  };
  const ctx = { api, me: { id: BOT_ID } } as unknown as MyContext;
  try {
    resetSecurityCaches();
    assert.equal((await banUser(ctx, chatId, USER_ID)).ok, false);
    assert.equal((await muteUser(ctx, chatId, USER_ID, 30)).ok, false);
    assert.equal(actionCalls, 0);
    const data = await getGroupData(chatId);
    assert.deepEqual(data.events.map((event) => event.result), ["rejected", "rejected"]);
  } finally {
    resetSecurityCaches();
    await flushStorage();
    const storageFile = resolve(process.cwd(), "data", "storage", `${chatId}.json`);
    if (existsSync(storageFile)) unlinkSync(storageFile);
  }
});
