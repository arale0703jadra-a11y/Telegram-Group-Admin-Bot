import assert from "node:assert/strict";
import test from "node:test";
import { calculateActivity } from "../src/services/activity.js";
import { initialGroupData } from "../src/storage/initial.js";

test("activity statistics use real messages and preserve group isolation", () => {
  const data = initialGroupData();
  const now = 1_700_000_000;
  data.activityMessages = [
    {
      messageId: 1,
      groupId: -100,
      userId: 10,
      firstName: "Ana",
      timestamp: now,
    },
    {
      messageId: 2,
      groupId: -100,
      userId: 10,
      firstName: "Ana",
      timestamp: now - 86_400,
    },
    {
      messageId: 3,
      groupId: -200,
      userId: 20,
      firstName: "Otro",
      timestamp: now,
    },
  ];

  const stats = calculateActivity(data, -100, now);
  assert.equal(stats.totalMessages, 2);
  assert.equal(stats.activeUsers, 1);
  assert.equal(stats.topUsers[0]?.userId, 10);
  assert.equal(stats.messagesLast7Days, 2);
});

test("activity statistics include multimedia and forwarded-message records equally", () => {
  const data = initialGroupData();
  data.activityMessages.push({
    messageId: 99,
    groupId: -100,
    userId: 42,
    firstName: "Media",
    username: "media",
    timestamp: 1_700_000_000,
  });
  const stats = calculateActivity(data, -100, 1_700_000_000);
  assert.equal(stats.totalMessages, 1);
  assert.equal(stats.topUsers[0]?.username, "media");
});
