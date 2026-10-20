import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import {
  getInactiveActivityCandidates,
  shouldTrackUserActivity,
  upsertUserActivity,
} from "../src/services/user-activity.js";
import {
  INACTIVITY_CLEANUP_DAYS,
  INACTIVITY_CLEANER_BATCH_SIZE,
  mergeInactivityCandidates,
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

test("activity upsert uses the security table and never clears a deleted marker", async () => {
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
  });
});

test("inactive candidate query validates and maps Supabase rows", async () => {
  const candidates = await getInactiveActivityCandidates(
    groupId,
    "2025-01-01T00:00:00.000Z",
    {
      config: { url: "https://example.supabase.co", key: "service-key" },
      fetcher: async () =>
        new Response(
          JSON.stringify([
            {
              group_id: groupId,
              user_id: userId,
              last_active_at: "2024-12-01T00:00:00.000Z",
              is_deleted: false,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.deepEqual(candidates, [
    {
      groupId,
      userId,
      lastActiveAt: "2024-12-01T00:00:00.000Z",
      isDeleted: false,
    },
  ]);
});

test("cleanup candidate merge preserves deleted flags and caps are conservative", () => {
  const candidates = mergeInactivityCandidates(
    [
      {
        groupId,
        userId,
        lastActiveAt: "2024-01-01T00:00:00.000Z",
        isDeleted: true,
      },
    ],
    {
      [String(userId)]: {
        id: userId,
        groupId,
        lastSeen: Math.floor(Date.parse("2024-06-01T00:00:00.000Z") / 1000),
      },
    },
    groupId,
    Date.parse("2025-01-01T00:00:00.000Z"),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.isDeleted, true);
  assert.equal(candidates[0]?.lastActiveAt, "2024-06-01T00:00:00.000Z");
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
