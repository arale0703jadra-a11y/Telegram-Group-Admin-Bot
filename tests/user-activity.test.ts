import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";
import { deletedAccounts } from "../src/filters/deleted-accounts.js";
import {
  getInactiveActivityCandidates,
  shouldTrackUserActivity,
  upsertUserActivity,
} from "../src/services/user-activity.js";
import {
  flushStorage,
  getGroupData,
} from "../src/storage/index.js";
import {
  INACTIVITY_CLEANUP_DAYS,
  INACTIVITY_CLEANER_BATCH_SIZE,
} from "../src/services/inactivity-cleaner.js";
import { isDeletedTelegramAccount } from "../src/filters/deleted-accounts.js";

const groupId = -1001234567890;
const userId = 123456789;

test("activity tracking excludes bots, admins, and non-members", () => {
  const makeMember = (status: string, isBot = false): ChatMember =>
    ({
      status,
      user: { id: userId, is_bot: isBot, first_name: "User" },
    }) as ChatMember;

  assert.equal(shouldTrackUserActivity(makeMember("member"), userId, false), true);
  assert.equal(shouldTrackUserActivity(makeMember("member", true), userId, false), false);
  assert.equal(shouldTrackUserActivity(makeMember("administrator"), userId, false), false);
  assert.equal(shouldTrackUserActivity(makeMember("left"), userId, false), false);
  assert.equal(shouldTrackUserActivity(makeMember("member"), userId, true), false);
});

test("activity upsert uses the security table and clears stale deleted markers", async () => {
  let requestUrl = "";
  let requestBody = "";
  await upsertUserActivity(groupId, userId, "2025-01-01T00:00:00.000Z", {
    config: { url: "https://example.supabase.co", key: "service-key" },
    fetcher: async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      return new Response(null, { status: 204 });
    },
  });

  assert.match(requestUrl, /security_user_activity\?on_conflict=group_id%2Cuser_id/u);
  assert.deepEqual(JSON.parse(requestBody), {
    group_id: groupId,
    user_id: userId,
    last_active_at: "2025-01-01T00:00:00.000Z",
    is_deleted: false,
  });
});

test("inactive candidate query validates and maps Supabase rows", async () => {
  let requestUrl = "";
  const candidates = await getInactiveActivityCandidates(
    groupId,
    "2025-01-01T00:00:00.000Z",
    {
      config: { url: "https://example.supabase.co", key: "service-key" },
      fetcher: async (input) => {
        requestUrl = String(input);
        return new Response(
          JSON.stringify([
            {
              group_id: groupId,
              user_id: userId,
              last_active_at: "2024-12-01T00:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.match(requestUrl, /last_active_at=lt\./u);
  assert.doesNotMatch(requestUrl, /is_deleted=eq\.true/u);
  assert.deepEqual(candidates, [
    {
      groupId,
      userId,
      lastActiveAt: "2024-12-01T00:00:00.000Z",
    },
  ]);
});

test("inactivity cleanup keeps its strict 21-day threshold and conservative batch size", () => {
  assert.equal(INACTIVITY_CLEANUP_DAYS, 21);
  assert.equal(INACTIVITY_CLEANER_BATCH_SIZE, 50);
});

test("deleted-account heuristic requires Telegram's explicit deleted name", () => {
  assert.equal(
    isDeletedTelegramAccount({ first_name: "Deleted Account" }),
    true,
  );
  assert.equal(
    isDeletedTelegramAccount({ first_name: "Deleted Account", username: "user" }),
    false,
  );
  assert.equal(isDeletedTelegramAccount({ first_name: "Anonymous" }), false);
});

test("a mutable Deleted Account profile only queues review and never moderates", async () => {
  const testChatId = -Math.floor(Date.now()) - 31;
  const file = resolve(process.cwd(), "data", "storage", `${testChatId}.json`);
  const moderationCalls: string[] = [];
  let continued = false;
  const message = {
    message_id: 1,
    chat: { id: testChatId, type: "supergroup", title: "Test" },
    from: { id: userId, is_bot: false, first_name: "Deleted Account" },
    date: Math.floor(Date.now() / 1000),
    text: "Synthetic test message",
  };
  try {
    const middleware = deletedAccounts.middleware();
    await middleware(
      {
        update: { update_id: 1, message },
        chat: message.chat,
        from: message.from,
        message,
        api: {
          banChatMember: async () => {
            moderationCalls.push("ban");
            return true;
          },
          unbanChatMember: async () => {
            moderationCalls.push("unban");
            return true;
          },
          deleteMessage: async () => {
            moderationCalls.push("delete");
            return true;
          },
        },
      } as unknown as MyContext,
      async () => {
        continued = true;
      },
    );
    await flushStorage();

    const data = await getGroupData(testChatId);
    assert.equal(continued, true);
    assert.deepEqual(moderationCalls, []);
    assert.match(data.events.at(-1)?.detail ?? "", /pending_review/u);
  } finally {
    await flushStorage();
    if (existsSync(file)) unlinkSync(file);
  }
});
