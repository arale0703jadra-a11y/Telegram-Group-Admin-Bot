import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import { unmuteUser } from "../src/moderation/actions.js";
import { flushStorage } from "../src/storage/index.js";
import { resetSecurityCaches } from "../src/utils/member-cache.js";

const BOT_ID = 900000001;
const USER_ID = 900000002;

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
