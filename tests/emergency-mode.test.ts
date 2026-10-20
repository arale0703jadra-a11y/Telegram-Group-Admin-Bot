import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember, ChatPermissions } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import { initialGroupData } from "../src/storage/initial.js";
import {
  EMERGENCY_MEMBER_PERMISSIONS,
  restrictRecentMembers,
  restoreEmergencyRestrictions,
} from "../src/services/emergency-mode.js";
import { isRecentEmergencyMember } from "../src/filters/anti-raid-engine.js";
import { buildProtectionCenterPanel, EmergencyAction } from "../src/menus/panels.js";
import { resetSecurityCaches } from "../src/utils/member-cache.js";
import { buttonCallbackData } from "./helpers.js";

const BOT_ID = 991000001;
const RECENT_ID = 991000002;
const OLD_ID = 991000003;
const TRUSTED_ID = 991000004;
const CHAT_ID = -991000001;

test("emergency recent-member policy uses a strict 24-hour join window", () => {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  assert.equal(isRecentEmergencyMember(nowSeconds - 86_399, now), true);
  assert.equal(isRecentEmergencyMember(nowSeconds - 86_400, now), false);
  assert.equal(isRecentEmergencyMember(undefined, now), false);
  assert.equal(isRecentEmergencyMember(nowSeconds + 1, now), false);
});

test("emergency restriction applies only to recent tracked members and can restore them", async () => {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const data = initialGroupData();
  data.emergency = {
    active: true,
    activatedAt: now,
    expiresAt: now + 5 * 60 * 1000,
  };
  data.indexedUsers[String(RECENT_ID)] = {
    id: RECENT_ID,
    joinedAt: nowSeconds - 60,
  };
  data.indexedUsers[String(OLD_ID)] = {
    id: OLD_ID,
    joinedAt: nowSeconds - 86_401,
  };
  data.indexedUsers[String(TRUSTED_ID)] = {
    id: TRUSTED_ID,
    joinedAt: nowSeconds - 60,
  };
  data.trustedUsers[String(TRUSTED_ID)] = true;

  const members = new Map<number, ChatMember>([
    [
      BOT_ID,
      {
        status: "administrator",
        user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
        can_restrict_members: true,
        can_delete_messages: true,
      } as ChatMember,
    ],
    ...[RECENT_ID, OLD_ID, TRUSTED_ID].map(
      (userId) =>
        [
          userId,
          {
            status: "member",
            user: { id: userId, is_bot: false, first_name: "Member" },
          } as ChatMember,
        ] as const,
    ),
  ]);
  const appliedPermissions: Array<{
    userId: number;
    permissions: ChatPermissions;
    untilDate?: number;
  }> = [];
  const defaultPermissions: ChatPermissions = {
    can_send_messages: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_invite_users: true,
  };
  const api = {
    getChatMember: async (_chatId: number | string, userId: number) => {
      const member = members.get(userId);
      if (!member) throw new Error(`Unknown member ${userId}`);
      return member;
    },
    restrictChatMember: async (
      _chatId: number | string,
      userId: number,
      permissions: ChatPermissions,
      options?: { until_date?: number },
    ) => {
      appliedPermissions.push({
        userId,
        permissions,
        untilDate: options?.until_date,
      });
      const current = members.get(userId);
      if (!current) throw new Error(`Unknown member ${userId}`);
      const user = current.user;
      members.set(
        userId,
        options?.until_date === 0
          ? ({ status: "member", user } as ChatMember)
          : ({
              status: "restricted",
              user,
              is_member: true,
              ...permissions,
            } as ChatMember),
      );
      return true;
    },
    getChat: async () => ({
      id: CHAT_ID,
      type: "supergroup",
      title: "test",
      permissions: defaultPermissions,
    }),
  };
  const ctx = {
    api,
    me: { id: BOT_ID },
  } as unknown as MyContext;

  try {
    resetSecurityCaches();
    const applied = await restrictRecentMembers(ctx, CHAT_ID, data, now);
    assert.deepEqual(applied, { restricted: 1, failed: 0 });
    assert.equal(appliedPermissions.length, 1);
    assert.equal(appliedPermissions[0]?.userId, RECENT_ID);
    assert.deepEqual(
      appliedPermissions[0]?.permissions,
      EMERGENCY_MEMBER_PERMISSIONS,
    );
    assert.ok(
      Math.abs(
        (appliedPermissions[0]?.untilDate ?? 0) -
          Math.ceil((now + 5 * 60 * 1000) / 1000),
      ) <= 1,
    );

    assert.equal(await restoreEmergencyRestrictions(ctx, CHAT_ID, data), true);
    assert.deepEqual(appliedPermissions[1], {
      userId: RECENT_ID,
      permissions: defaultPermissions,
      untilDate: 0,
    });
    assert.equal(data.emergency.restrictedUsers?.[String(RECENT_ID)], undefined);
  } finally {
    resetSecurityCaches();
  }
});

test("protection center presents the current emergency toggle", () => {
  const activePanel = buildProtectionCenterPanel(
    { active: true, expiresAt: Date.now() + 60_000 },
    10,
  );
  const inactivePanel = buildProtectionCenterPanel({ active: false }, 10);
  const activeCallbacks = activePanel.keyboard.inline_keyboard
    .flat()
    .map(buttonCallbackData);
  const inactiveCallbacks = inactivePanel.keyboard.inline_keyboard
    .flat()
    .map(buttonCallbackData);

  assert.match(activePanel.text, /Modo de emergencia: \*ACTIVO\*/u);
  assert.match(inactivePanel.text, /Modo de emergencia: \*inactivo\*/u);
  assert.ok(activeCallbacks.includes(EmergencyAction.toggle));
  assert.ok(inactiveCallbacks.includes(EmergencyAction.toggle));
});
