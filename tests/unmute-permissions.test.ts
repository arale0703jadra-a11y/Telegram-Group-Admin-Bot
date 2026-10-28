import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import { muteUser, unmuteUser } from "../src/moderation/actions.js";
import { flushStorage, getGroupData, saveGroupData } from "../src/storage/index.js";
import { resetSecurityCaches } from "../src/utils/member-cache.js";

const BOT_ID = 900000011;
const USER_ID = 900000012;

const SNAPSHOT: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: false,
  can_send_documents: true,
  can_send_photos: false,
  can_send_videos: true,
  can_send_video_notes: false,
  can_send_voice_notes: true,
  can_send_polls: false,
  can_send_other_messages: true,
  can_add_web_page_previews: false,
  can_react_to_messages: true,
  can_change_info: false,
  can_invite_users: true,
  can_edit_tag: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

function createCtx(options: {
  member?: Partial<ChatMember>;
  restrictThrows?: boolean;
}): { ctx: MyContext; restored: ChatPermissions[] } {
  const restored: ChatPermissions[] = [];
  const api = {
    getChatMember: async (_chatId: number | string, userId: number): Promise<ChatMember> =>
      userId === BOT_ID
        ? ({
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_restrict_members: true,
            can_delete_messages: true,
          } as ChatMember)
        : ({
            status: "restricted",
            user: { id: USER_ID, is_bot: false, first_name: "Member" },
            is_member: true,
            ...options.member,
          } as ChatMember),
    restrictChatMember: async (
      _chatId: number | string,
      _userId: number,
      permissions: ChatPermissions,
    ): Promise<boolean> => {
      if (options.restrictThrows) throw new Error("boom");
      restored.push(permissions);
      return true;
    },
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
    from: { id: 42, first_name: "Admin" },
  } as unknown as MyContext;
  return { ctx, restored };
}

function storageFileFor(chatId: number): string {
  return resolve(process.cwd(), "data", "storage", `${chatId}.json`);
}

async function cleanup(chatId: number): Promise<void> {
  resetSecurityCaches();
  await flushStorage();
  const file = storageFileFor(chatId);
  if (existsSync(file)) unlinkSync(file);
}

test("unmute restaura exactamente los permisos previos capturados", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx, restored } = createCtx({});
  try {
    resetSecurityCaches();
    const data = await getGroupData(chatId);
    data.mutedUsers[String(USER_ID)] = {
      until: 9_999_999_999,
      previousPermissions: SNAPSHOT,
    };
    await saveGroupData(chatId, data);

    const result = await unmuteUser(ctx, chatId, USER_ID, "Member");

    assert.equal(result.ok, true);
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0], SNAPSHOT);
  } finally {
    await cleanup(chatId);
  }
});

test("unmute con snapshot corrupto cae a los permisos básicos por defecto", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx, restored } = createCtx({});
  try {
    resetSecurityCaches();
    const data = await getGroupData(chatId);
    data.mutedUsers[String(USER_ID)] = {
      until: 9_999_999_999,
      previousPermissions: {
        can_send_messages: "yes",
      } as unknown as ChatPermissions,
    };
    await saveGroupData(chatId, data);

    const result = await unmuteUser(ctx, chatId, USER_ID, "Member");

    assert.equal(result.ok, true);
    assert.equal(restored.length, 1);
    const permissions = restored[0];
    assert.ok(permissions);
    assert.equal(permissions.can_send_messages, true);
    assert.equal(permissions.can_add_web_page_previews, true);
    assert.equal(permissions.can_change_info, false);
    assert.equal(permissions.can_invite_users, false);
    assert.equal(permissions.can_pin_messages, false);
    assert.equal(permissions.can_manage_topics, false);
  } finally {
    await cleanup(chatId);
  }
});

test("unmute informa del error de Telegram sin dar la acción por completada", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx } = createCtx({ restrictThrows: true });
  try {
    resetSecurityCaches();
    const result = await unmuteUser(ctx, chatId, USER_ID, "Member");

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No se pudo quitar el silencio/u);
  } finally {
    await cleanup(chatId);
  }
});

test("mute captura el snapshot de permisos de un miembro restringido", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx } = createCtx({ member: SNAPSHOT as Partial<ChatMember> });
  try {
    resetSecurityCaches();
    const result = await muteUser(ctx, chatId, USER_ID, 10, "Member");

    assert.equal(result.ok, true);
    const data = await getGroupData(chatId);
    assert.deepEqual(
      data.mutedUsers[String(USER_ID)]?.previousPermissions,
      SNAPSHOT,
    );
  } finally {
    await cleanup(chatId);
  }
});

test("repetir mute conserva el snapshot original de permisos", async () => {
  const chatId = -Math.floor(Math.random() * 1e9) - 1000;
  const { ctx } = createCtx({ member: SNAPSHOT as Partial<ChatMember> });
  try {
    resetSecurityCaches();
    const data = await getGroupData(chatId);
    data.mutedUsers[String(USER_ID)] = {
      until: Math.floor(Date.now() / 1000) + 3600,
      previousPermissions: SNAPSHOT,
    };
    await saveGroupData(chatId, data);

    const result = await muteUser(ctx, chatId, USER_ID, 20, "Member");

    assert.equal(result.ok, true);
    const updated = await getGroupData(chatId);
    assert.deepEqual(
      updated.mutedUsers[String(USER_ID)]?.previousPermissions,
      SNAPSHOT,
    );
  } finally {
    await cleanup(chatId);
  }
});