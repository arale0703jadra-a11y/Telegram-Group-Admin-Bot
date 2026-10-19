import assert from "node:assert/strict";
import test from "node:test";
import { cleanMemberJoinServiceMessage } from "../src/commands/clean-service-messages.js";

function context(
  message: {
    message_id: number;
    new_chat_members?: unknown[];
    community_chat_joined?: unknown;
    text?: string;
  },
  overrides: {
    chatType?: string;
    deleteMessage?: (chatId: number | string, messageId: number) => Promise<unknown>;
  } = {},
) {
  const deletions: Array<[number | string, number]> = [];
  const api = {
    deleteMessage: async (chatId: number | string, messageId: number) => {
      deletions.push([chatId, messageId]);
      return overrides.deleteMessage
        ? overrides.deleteMessage(chatId, messageId)
        : true;
    },
  };
  return {
    value: {
      chat: { id: -100123, type: overrides.chatType ?? "supergroup" },
      message,
      api,
    },
    deletions,
  };
}

test("deletes a member-join service message without relying on its displayed text", async () => {
  const fixture = context({
    message_id: 78,
    new_chat_members: [{ id: 456, first_name: "ال" }],
  });
  let continued = false;

  await cleanMemberJoinServiceMessage(fixture.value, async () => {
    continued = true;
  });

  assert.deepEqual(fixture.deletions, [[-100123, 78]]);
  assert.equal(continued, true);
});

test("Unicode and bidirectional control characters in member names do not affect cleanup", async () => {
  for (const firstName of ["‎⁨ال⁩", "山田 太郎", "Мария", "José"]) {
    const fixture = context({
      message_id: 79,
      new_chat_members: [{ id: 457, first_name: firstName }],
    });
    await cleanMemberJoinServiceMessage(fixture.value, async () => {});
    assert.deepEqual(fixture.deletions, [[-100123, 79]]);
  }
});

test("deletes the service message for a user joining from a linked community", async () => {
  const fixture = context({
    message_id: 84,
    community_chat_joined: { chat: { id: -100999, title: "Community" } },
  });
  let continued = false;
  await cleanMemberJoinServiceMessage(fixture.value, async () => {
    continued = true;
  });
  assert.deepEqual(fixture.deletions, [[-100123, 84]]);
  assert.equal(continued, true);
});

test("normal messages and unrelated service messages are not deleted", async () => {
  const ordinary = context({ message_id: 80, text: "Se aceptó a alguien en el grupo." });
  let ordinaryContinued = false;
  await cleanMemberJoinServiceMessage(ordinary.value, async () => {
    ordinaryContinued = true;
  });

  const titleChange = context({ message_id: 81, new_chat_members: [] });
  await cleanMemberJoinServiceMessage(titleChange.value, async () => {});

  assert.deepEqual(ordinary.deletions, []);
  assert.equal(ordinaryContinued, true);
  assert.deepEqual(titleChange.deletions, []);
});

test("failed deletions are logged safely and do not block later handlers", async () => {
  const secretLikeDescription = "do-not-log-this-detail";
  const fixture = context(
    {
      message_id: 82,
      new_chat_members: [{ id: 458, first_name: "Ana" }],
    },
    {
      deleteMessage: async () => {
        throw Object.assign(new Error(secretLikeDescription), { error_code: 403 });
      },
    },
  );
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => logs.push(String(message));
  let continued = false;
  try {
    await cleanMemberJoinServiceMessage(fixture.value, async () => {
      continued = true;
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(fixture.deletions.length, 1);
  assert.equal(continued, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /groupId=-100123/);
  assert.match(logs[0] ?? "", /messageId=82/);
  assert.match(logs[0] ?? "", /telegram_403/);
  assert.doesNotMatch(logs[0] ?? "", new RegExp(secretLikeDescription));
});

test("messages outside groups are left alone", async () => {
  const fixture = context(
    {
      message_id: 83,
      new_chat_members: [{ id: 459, first_name: "Sam" }],
    },
    { chatType: "private" },
  );
  await cleanMemberJoinServiceMessage(fixture.value, async () => {});
  assert.deepEqual(fixture.deletions, []);
});
